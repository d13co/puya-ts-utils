import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import type { TransactionComposer } from '@algorandfoundation/algokit-utils/types/composer'
import { ABIMethod, Address, encodeAddress, getApplicationAddress, makeEmptyTransactionSigner, type TransactionSigner } from 'algosdk'
import { MbrErrorMessages } from './generated/mbrErrors.js'

/*
 * Off chain: helpers for any app built on MbrManager. They build calls from the
 * ABI signatures MbrManager declares, not from a typed client, so they work
 * whatever the app is.
 */

export { MbrErrorMessages }

/** A credit box's minimum balance: 2500 + 400 × (33-byte name + 8-byte value). */
export const CREDIT_BOX_MBR_MICROALGOS = 18_900

/** Accounts per logCredits call: 63 addresses still fit the 2 KB of app args. */
export const ACCOUNTS_PER_CALL = 63
/** Accounts per simulated group: two logCredits calls. */
export const ACCOUNTS_PER_GROUP = 2 * ACCOUNTS_PER_CALL

export const SIMULATE_PARAMS = {
  allowMoreLogging: true,
  allowUnnamedResources: true,
  extraOpcodeBudget: 130013,
  fixSigners: true,
  allowEmptySignatures: true,
}

const DEPOSIT_CREDITS = ABIMethod.fromSignature('depositCredits(address,pay)void')
const WITHDRAW_CREDITS = ABIMethod.fromSignature('withdrawCredits()void')
const LOG_CREDITS = ABIMethod.fromSignature('logCredits(address[])void')

/** A credit box name: 'c' and the account's 32-byte public key. */
export function creditBoxName(account: string | Address | Uint8Array): Uint8Array {
  const publicKey = account instanceof Uint8Array ? account : Address.fromString(account.toString()).publicKey
  return new Uint8Array([0x63, ...publicKey])
}

export type MbrApp = { algorand: AlgorandClient; appId: bigint }
export type MbrSender = { sender: string | Address; signer?: TransactionSigner }

/**
 * Add a deposit of `amount` MBR credits for `creditor`, the sender by default: a
 * payment to the app, then the depositCredits call. The group is not sent.
 *
 * A first deposit opens the creditor's credit box and pays its
 * `CREDIT_BOX_MBR_MICROALGOS` out of itself, so one below that reverts with
 * `ERR:crd`.
 *
 * Async because the payment is built here, which fetches suggested params: a
 * payment promise handed to the composer unawaited would reject unobserved if
 * algod failed before the composer got to it.
 */
export async function addDepositCredits(
  composer: TransactionComposer,
  { algorand, appId, sender, signer, amount, creditor = sender }: MbrApp & MbrSender & { amount: AlgoAmount; creditor?: string | Address },
): Promise<TransactionComposer> {
  const payment = await algorand.createTransaction.payment({ sender, receiver: getApplicationAddress(appId), amount })
  return composer.addAppCallMethodCall({
    appId,
    sender,
    signer,
    method: DEPOSIT_CREDITS,
    args: [creditor.toString(), payment],
    boxReferences: [creditBoxName(creditor)],
  })
}

/**
 * Add a withdrawCredits call, which pays the sender's credits back along with
 * the credit box's own MBR. Its extra fee covers the zero-fee inner refund. The
 * group is not sent.
 */
export function addWithdrawCredits(composer: TransactionComposer, { appId, sender, signer }: Omit<MbrApp, 'algorand'> & MbrSender): TransactionComposer {
  return composer.addAppCallMethodCall({
    appId,
    sender,
    signer,
    method: WITHDRAW_CREDITS,
    args: [],
    boxReferences: [creditBoxName(sender)],
    extraFee: AlgoAmount.MicroAlgo(1000),
  })
}

/**
 * Each account's MBR credits, `undefined` for one with no credit box, in the
 * order given. Read by simulating logCredits, so no signer is needed: the calls
 * are sent from `reader`, the app's own address by default. Up to `concurrency`
 * groups of `ACCOUNTS_PER_GROUP` are simulated at once.
 */
export async function getCredits(
  { algorand, appId, reader, concurrency = 2 }: MbrApp & { reader?: string | Address; concurrency?: number },
  accounts: (string | Address)[],
): Promise<(bigint | undefined)[]> {
  const sender = reader ?? getApplicationAddress(appId)
  const readGroup = async (start: number) => {
    const group = algorand.newGroup()
    for (let i = start; i < Math.min(start + ACCOUNTS_PER_GROUP, accounts.length); i += ACCOUNTS_PER_CALL) {
      group.addAppCallMethodCall({
        appId,
        sender,
        signer: makeEmptyTransactionSigner(),
        method: LOG_CREDITS,
        args: [accounts.slice(i, i + ACCOUNTS_PER_CALL).map(String)],
      })
    }
    const { confirmations } = await group.simulate(SIMULATE_PARAMS)
    // One log line per account: empty for no credit box, else a big-endian uint64.
    return confirmations.flatMap(({ logs = [] }) =>
      logs.map((log) => (log.length ? new DataView(log.buffer, log.byteOffset).getBigUint64(0) : undefined)),
    )
  }

  const starts = Array.from({ length: Math.ceil(accounts.length / ACCOUNTS_PER_GROUP) }, (_, g) => g * ACCOUNTS_PER_GROUP)
  const results: (bigint | undefined)[][] = []
  let next = 0
  const worker = async () => {
    while (next < starts.length) {
      const g = next++
      results[g] = await readGroup(starts[g])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, starts.length)) }, worker))
  return results.flat()
}

/** Every account's MBR credits, by address: the credit boxes are found by name, then read with getCredits. */
export async function getAllCredits(app: MbrApp & { reader?: string | Address; concurrency?: number }): Promise<Map<string, bigint>> {
  const accounts = (await app.algorand.app.getBoxNames(app.appId))
    .map(({ nameRaw }) => nameRaw)
    .filter((name) => name.length === 33 && name[0] === 0x63)
    .map((name) => encodeAddress(name.slice(1)))
  const credits = await getCredits(app, accounts)
  // A box deleted between the scan and the read comes back undefined: skip it.
  return new Map(accounts.flatMap((account, i) => (credits[i] === undefined ? [] : [[account, credits[i]!] as const])))
}
