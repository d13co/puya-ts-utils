import { Account, Bytes, Global, itxn, OnCompleteAction, uint64 } from '@algorandfoundation/algorand-typescript'

/**
 * The smallest program that approves everything: `#pragma version 10`, `pushint 1`.
 *
 * The probe application exists only for as long as it takes to be assigned an
 * id, so its programs never have to do anything. Both the approval and the clear
 * state program are this.
 */
const PROBE_PROGRAM = Bytes.fromHex('0a8101')

/**
 * Read the network's transaction counter, forwarding it by 1 while doing so. Costs 1 minimum fee, paid by `feePayer` (or the caller if `feePayer` is the zero address).
 *
 * Every application on Algorand is numbered out of one ledger-wide counter that
 * advances by one for each transaction, inner transactions included. So an
 * application created right now is handed the counter's current value, and the
 * value one past it is what the next transaction on the network will be
 * numbered — which is what this returns.
 *
 * The counter is read by creating a throwaway application and deleting it again
 * in the same inner transaction, purely to see which id it was given. Nothing is
 * left behind on the ledger, except for a +1 increment of the txnCounter.
 *
 * ```ts
 * const counter = getTxnCounter(Global.zeroAddress)
 * ```
 *
 * `feePayer` decides who covers the one inner transaction this costs:
 *
 * - `Global.zeroAddress` submits it with `fee: 0`, sent from this application's
 *   own escrow. Nothing is spent, and the caller covers it out of the fee pool.
 * - any other account submits it with `fee: Global.minTxnFee`, sent from that
 *   account, which pays the fee out of its own balance.
 *
 * A `feePayer` other than the zero address has to be an account this contract
 * can send from: either its own escrow, or an account rekeyed to it. Anything
 * else is rejected by the AVM when the inner transaction is submitted.
 *
 * Costs **1 inner transaction** either way.
 */
export function getTxnCounter(feePayer: Account): uint64 {
  const selfFunded = feePayer === Global.zeroAddress

  const probe = itxn
    .applicationCall({
      approvalProgram: PROBE_PROGRAM,
      clearStateProgram: PROBE_PROGRAM,
      onCompletion: OnCompleteAction.DeleteApplication,
      sender: selfFunded ? Global.currentApplicationAddress : feePayer,
      fee: selfFunded ? 0 : Global.minTxnFee,
    })
    .submit()

  return probe.createdApp.id + 1
}
