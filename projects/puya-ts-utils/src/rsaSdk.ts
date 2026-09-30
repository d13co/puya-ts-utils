import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import type { TransactionComposer } from '@algorandfoundation/algokit-utils/types/composer'
import { createHash } from 'node:crypto'
import { Address, getApplicationAddress, makeEmptyTransactionSigner, modelsv2, TransactionSigner } from 'algosdk'
import { ErrorMessages } from './generated/errors.js'
import { RsaSplitConsumerClient, RsaSplitConsumerComposer, RsaSplitConsumerFactory } from './generated/RsaSplitConsumerClient.js'
import { RSA_SHA256_VERIFIER } from './generated/rsaSha256Verifier.js'
import { creditBoxName, getCredits, SIMULATE_PARAMS } from './mbrManagerSdk.js'

/*
 * Off chain: an SDK for the RSA verifiers in this package's examples, the
 * RsaSha256Verifier logic signature and the RsaSplitConsumer app. Every
 * rejection with an error code comes back as `Error CODE: message`, the logic
 * signature's included, though a logic signature cannot log: its rejections
 * are mapped from the failing pc.
 */

export { ErrorMessages, SIMULATE_PARAMS }
/** Deploys RsaSplitConsumer: its compiled programs are built in, so no source is needed. */
export { RsaSplitConsumerClient, RsaSplitConsumerFactory }

export type SenderWithSigner = { sender: Address | string; signer: TransactionSigner }

/** Most transactions in a group. */
export const MAX_GROUP_SIZE = 16
/** Budget each transaction in a group adds to the logic signature pool. */
export const LSIG_BUDGET_PER_TXN = 20_000
/** Budget an app call or inner OpUp call adds to the pool. */
export const APP_BUDGET_PER_CALL = 700
/** Most inner transactions a group can issue: 16 per app call. */
export const MAX_INNER_TXNS = 256
const MIN_FEE = 1000

const verifierProgram = new Uint8Array(Buffer.from(RSA_SHA256_VERIFIER.program, 'base64'))
/** How algod prints the verifier's program in a rejection. */
const verifierLogic = `Logic:[${verifierProgram.join(' ')}]`

/**
 * Rewrites an `ERR:CODE` anywhere in the message to `Error CODE: message`, and
 * sets `code` and `description`. An app's plain asserts reach the message
 * through algokit's ARC-56 source info, and its logged asserts through the log.
 * A verifier rejection carries only a pc: it is mapped to its code first.
 */
export const errorTransformer = async (error: Error): Promise<Error> => {
  if (error.message.includes(verifierLogic)) {
    const pc = /rejected by logic err=assert failed pc=(\d+)/.exec(error.message)?.[1]
    const code = pc && RSA_SHA256_VERIFIER.errorPcs[Number(pc)]
    if (code) error.message = `${code} ${error.message}`
  }
  const [code] = /ERR:[^" ]+/.exec(error.message) ?? []
  if (!code) return error
  const description = ErrorMessages[code] ?? 'Unknown error'
  const message = `${code.replace('ERR:', 'Error ')}: ${description}`
  error.stack = `${message}\n    ${error.message}\n${error.stack}`
  error.message = message
  Object.assign(error, { code, description })
  return error
}

/**
 * Register `errorTransformer` after every transformer registered so far. The
 * client keeps them in a Set, in first registration order: an app client's own
 * transformer, which puts the ARC-56 error message in place, has to run first.
 */
const registerLast = (algorand: AlgorandClient) => {
  algorand.unregisterErrorTransformer(errorTransformer)
  algorand.registerErrorTransformer(errorTransformer)
}

const nonce = () => Math.floor(Math.random() * 1e9)

export type VerifyArgs = {
  /** SHA-256 of what the RRSIG signs. */
  digest: Uint8Array
  signature: Uint8Array
  /** The DNSKEY record's public key field. */
  publicKey: Uint8Array
  /** From `rsaMontgomeryHint`; empty computes it on chain, for about 2 more transactions. */
  hint?: Uint8Array
  /** Transactions to pool budget over. Probed by simulating when left out. */
  groupSize?: number
}

/**
 * The RsaSha256Verifier logic signature: approves a zero payment from itself
 * whose note is `sha256(key) ‖ digest`, when the signature verifies. It pools
 * budget from padding payments the writer sends, and the writer pays every fee.
 */
export class RsaVerifierSDK {
  public algorand: AlgorandClient
  public writerAccount?: SenderWithSigner
  public program = verifierProgram

  constructor({ algorand, writerAccount }: { algorand: AlgorandClient; writerAccount?: SenderWithSigner }) {
    this.algorand = algorand
    this.writerAccount = writerAccount
    registerLast(algorand)
  }

  /** The verifier with these args. Its address is the same whatever they are. */
  verifier({ digest, signature, publicKey, hint = new Uint8Array() }: VerifyArgs) {
    // algosdk takes plain Uint8Arrays only, not Buffers.
    return this.algorand.account.logicsig(this.program, [digest, signature, publicKey, hint].map((a) => new Uint8Array(a)))
  }

  /** Verify the signature on chain, or reject with its error code. */
  async verify(args: VerifyArgs) {
    const groupSize = args.groupSize ?? (await this.probeGroupSize(args))
    return (await this.makeVerifyTxns({ ...args, groupSize })).send()
  }

  private makeVerifyTxns({ groupSize = MAX_GROUP_SIZE, builder, ...args }: VerifyArgs & { builder?: TransactionComposer }) {
    const { sender, signer } = this.writerAccount!
    const verifier = this.verifier(args)
    const note = new Uint8Array([...createHash('sha256').update(args.publicKey).digest(), ...args.digest])
    builder = (builder ?? this.algorand.newGroup()).addPayment({
      sender: verifier,
      receiver: verifier,
      amount: AlgoAmount.MicroAlgo(0),
      staticFee: AlgoAmount.MicroAlgo(0),
      note,
    })
    const n = nonce()
    for (let i = 1; i < groupSize; i++) {
      builder = builder.addPayment({
        sender,
        signer,
        receiver: sender,
        amount: AlgoAmount.MicroAlgo(0),
        staticFee: AlgoAmount.MicroAlgo(i === 1 ? MIN_FEE * groupSize : 0),
        note: `pool ${n} ${i}`,
      })
    }
    return builder
  }

  /**
   * The smallest group that pools the budget the verifier uses, from simulating
   * it in a full one. The padding goes unsigned, so no wallet is asked. A full
   * group if the simulation fails, so sending reports the real error, not a
   * budget one.
   */
  private async probeGroupSize(args: VerifyArgs) {
    const atc = (await this.makeVerifyTxns({ ...args, groupSize: MAX_GROUP_SIZE }).build()).atc.clone()
    // @ts-expect-error private
    for (const t of atc.transactions.slice(1)) t.signer = makeEmptyTransactionSigner()
    const { simulateResponse } = await atc.simulate(
      this.algorand.client.algod,
      new modelsv2.SimulateRequest({ txnGroups: [], allowEmptySignatures: true }),
    )
    const [{ failureMessage, txnResults }] = simulateResponse.txnGroups
    const used = txnResults[0].logicSigBudgetConsumed
    if (failureMessage || !used) return MAX_GROUP_SIZE
    return Math.max(2, Math.ceil(used / LSIG_BUDGET_PER_TXN))
  }
}

/** Reads from an RsaSplitConsumer app. Needs no signer: reads are simulated from the app address. */
export class RsaSplitReaderSDK {
  public algorand: AlgorandClient
  public appId: bigint
  public appAddress: Address
  public readClient: RsaSplitConsumerClient
  public readerAccount?: string

  constructor({ algorand, appId, readerAccount }: { algorand: AlgorandClient; appId: bigint; readerAccount?: string }) {
    this.algorand = algorand
    this.appId = appId
    this.appAddress = getApplicationAddress(appId)
    this.readerAccount = readerAccount
    this.readClient = new RsaSplitConsumerClient({
      algorand,
      appId,
      defaultSender: readerAccount ?? this.appAddress.toString(),
      defaultSigner: makeEmptyTransactionSigner(),
    })
    registerLast(algorand)
  }

  /** Each account's MBR credits, `undefined` for one with no credit box. */
  async credits(accounts: (Address | string)[]): Promise<(bigint | undefined)[]> {
    return getCredits({ algorand: this.algorand, appId: this.appId, reader: this.readerAccount }, accounts)
  }
}

/** One call in a split verification group. `budget` is what the call raises the pooled budget to. */
export type SplitCall =
  | { start: { signature: Uint8Array; publicKey: Uint8Array; hint: Uint8Array; budget: number } }
  | { step: { bits: number; budget: number } }
  | { finish: { signedData: Uint8Array; publicKey: Uint8Array } }

/**
 * Writes to an RsaSplitConsumer app: a verification too expensive for one group
 * (RSA-4096), run in pieces over several with its state in a box.
 */
export class RsaSplitSDK extends RsaSplitReaderSDK {
  public writerAccount: SenderWithSigner
  public writeClient: RsaSplitConsumerClient

  constructor({ writerAccount, ...args }: { algorand: AlgorandClient; appId: bigint; writerAccount: SenderWithSigner }) {
    super(args)
    this.writerAccount = writerAccount
    this.writeClient = new RsaSplitConsumerClient({
      algorand: args.algorand,
      appId: args.appId,
      defaultSender: writerAccount.sender.toString(),
      defaultSigner: writerAccount.signer,
    })
    registerLast(args.algorand)
  }

  /** Deposit MBR credits for `creditor`, the writer by default. The state box is paid from them. */
  async depositCredits(args: { amount: AlgoAmount; creditor?: Address | string }) {
    return (await this.makeDepositCreditsTxns(args)).send()
  }

  /** Cancel the writer's pending verification and refund its state-box MBR to their credits. */
  async cancel() {
    return this.writeClient.send.cancel({ args: [], populateAppCallResources: true })
  }

  /**
   * Send `calls` in one group, padded out with `pool` calls for the budget and
   * inner transaction slots they pool, and return each call's return value
   * (`step`: bits left, `finish`: whether the signature verified).
   */
  async run(calls: SplitCall[]): Promise<(bigint | boolean | undefined)[]> {
    const { returns } = await (await this.makeRunTxns({ calls })).send({ populateAppCallResources: true })
    return returns.slice(0, calls.length)
  }

  private makeDepositCreditsTxns({ amount, creditor, builder }: { amount: AlgoAmount; creditor?: Address | string; builder?: Composer }) {
    const { sender, signer } = this.writerAccount
    creditor ??= sender
    const txn = this.algorand.createTransaction.payment({ sender, receiver: this.appAddress, amount })
    return (builder ?? this.writeClient.newGroup()).depositCredits({
      args: { creditor: creditor.toString(), txn },
      boxReferences: [creditBoxName(creditor)],
      sender,
      signer,
    })
  }

  /**
   * The group for `run`. The first call pays every fee: the group's, and one per
   * inner OpUp the budgets may need. Must end its group: it pads to a full one.
   */
  private async makeRunTxns({ calls, builder }: { calls: SplitCall[]; builder?: Composer }) {
    const { sender, signer } = this.writerAccount
    builder ??= this.writeClient.newGroup()
    const used = await (await builder.composer()).count()
    const budget = calls.reduce((sum, call) => sum + ('start' in call ? call.start.budget : 'step' in call ? call.step.budget : 0), 0)
    const inner = Math.min(MAX_INNER_TXNS, Math.ceil(budget / APP_BUDGET_PER_CALL))
    const n = nonce()
    calls.forEach((call, i) => {
      const common = { sender, signer, staticFee: AlgoAmount.MicroAlgo(i === 0 ? MIN_FEE * (MAX_GROUP_SIZE + inner) : 0) }
      if ('start' in call) builder = builder!.start({ args: call.start, ...common })
      else if ('step' in call) builder = builder!.step({ args: call.step, ...common })
      else builder = builder!.finish({ args: call.finish, ...common })
    })
    for (let i = used + calls.length; i < MAX_GROUP_SIZE; i++) {
      builder = builder.pool({ args: [], sender, signer, note: `pool ${n} ${i}`, staticFee: AlgoAmount.MicroAlgo(0) })
    }
    return builder
  }
}

// The composer's type grows with each call chained on: widen it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Composer = RsaSplitConsumerComposer<any>
