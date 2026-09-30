import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import type { TransactionComposer } from '@algorandfoundation/algokit-utils/types/composer'
import { ABIMethod, Address, encodeAddress, getApplicationAddress, type TransactionSigner } from 'algosdk'
import { MbrErrorMessages } from './generated/mbrErrors.js'

/*
 * Off chain: helpers for any app built on MbrManager. Deposits and withdrawals
 * use its ABI signatures without a typed client; credit balances come directly
 * from its boxes through algod.
 */

export { MbrErrorMessages }

/** A credit box's minimum balance: 2500 + 400 × (33-byte name + 8-byte value). */
export const CREDIT_BOX_MBR_MICROALGOS = 18_900

/** @deprecated Credit reads use box queries now; the former logCredits call limit was 63 accounts. */
export const ACCOUNTS_PER_CALL = 63
/** @deprecated Credit reads use box queries now; the former simulated group limit was 126 accounts. */
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
 * order given. Queries algod directly, with up to `concurrency` box reads at once.
 * No signer or spendable app balance is needed. Each box may be read at a different
 * round. `reader` is accepted for compatibility but is no longer used.
 */
export async function getCredits(
  { algorand, appId, concurrency = 2 }: MbrApp & { reader?: string | Address; concurrency?: number },
  accounts: (string | Address)[],
): Promise<(bigint | undefined)[]> {
  const results = new Array<bigint | undefined>(accounts.length)
  let next = 0
  const worker = async () => {
    while (next < accounts.length) {
      const i = next++
      let value: Uint8Array
      try {
        value = await algorand.app.getBoxValue(appId, creditBoxName(accounts[i]))
      } catch (error) {
        // Only a missing box means no credit balance. Propagate node/network failures.
        if ((error as { response?: { status?: number } } | undefined)?.response?.status !== 404) throw error
        results[i] = undefined
        continue
      }
      if (value.length !== 8) throw new Error(`Invalid credit box length: expected 8 bytes, got ${value.length}`)
      results[i] = new DataView(value.buffer, value.byteOffset, value.byteLength).getBigUint64(0)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, accounts.length)) }, worker))
  return results
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
