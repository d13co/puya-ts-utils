import { Account, Contract, Global, GlobalState, uint64 } from '@algorandfoundation/algorand-typescript'
import { getTxnCounter } from '../../src/getTxnCounter.algo'

/**
 * Exercises the counter subroutine the way a real contract would.
 *
 * This exists to give the test suites something to call, and doubles as the
 * worked example for both of them.
 */
export class TxnCounterConsumer extends Contract {
  /** The counter read by the most recent call. */
  counter = GlobalState<uint64>({ key: 'counter' })

  /**
   * Read the counter, leaving the caller to cover the inner transaction out of
   * the fee pool.
   */
  public read(): uint64 {
    const counter = getTxnCounter(Global.zeroAddress)

    this.counter.value = counter
    return counter
  }

  /**
   * Read the counter, charging the inner transaction to `feePayer` — this
   * application's escrow, or any account rekeyed to it.
   *
   * WARNING: this is unguarded, so anyone can call it to spend `feePayer`'s
   * balance, one minimum fee per call. A real contract should check who is
   * calling before letting them pick the fee payer.
   */
  public readPaidBy(feePayer: Account): uint64 {
    const counter = getTxnCounter(feePayer)

    this.counter.value = counter
    return counter
  }
}
