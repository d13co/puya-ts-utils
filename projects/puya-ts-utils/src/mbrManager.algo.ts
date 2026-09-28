import {
  Account,
  BoxMap,
  Bytes,
  Contract,
  Global,
  gtxn,
  itxn,
  log,
  loggedAssert,
  op,
  readonly,
  Txn,
  uint64,
} from '@algorandfoundation/algorand-typescript'

/** Insufficient credits to cover MBR increase. Deposit more credits and try again. */
export const errCredit = 'CRD'
/** Payment receiver must be the contract, or the account being refunded has no credit box. */
export const errReceiver = 'RCV'
/** Amount must be greater than zero, or the sender has no credit box to withdraw. */
export const errAmt = 'AMT'

/**
 * MBR credit accounting: accounts deposit credits up front, and mutating methods settle
 * the app account's actual minimum-balance delta against the sender's credit. The AVM
 * enforces MBR once, at the end of an app call — it can be temporarily violated inside
 * one — so the snapshot/settle pair around the state changes measures the exact cost
 * with no byte-count math to keep in sync.
 *
 * ```ts
 * export class Registry extends MbrManager {
 *   entries = BoxMap<Account, bytes>({ keyPrefix: 'e' })
 *
 *   public put(value: bytes) {
 *     const mbrBefore = Global.currentApplicationAddress.minBalance
 *     this.entries(Txn.sender).value = value
 *     this.manageMbrCredits(mbrBefore)
 *   }
 * }
 * ```
 *
 * Built for a user-owns-boxes model: every box a method creates or deletes belongs to the
 * account being charged or refunded. Refunds go to whoever triggers the decrease, not to
 * whoever paid, so boxes shared between accounts break the accounting.
 *
 * Credit boxes are named `'c'` + the account's 32-byte public key (33 bytes); keep other
 * box keys disjoint from that.
 */
export abstract class MbrManager extends Contract {
  public userCredits = BoxMap<Account, uint64>({ keyPrefix: 'c' })

  /**
   * Settle MBR credits by comparing pre and post MBR: deduct any increase from the
   * sender's credits, refund any decrease to them. Call at the end of any method that
   * may change MBR, after the state changes that cause it.
   * @param mbrBefore Minimum balance snapshotted at the start of the method.
   */
  protected manageMbrCredits(mbrBefore: uint64) {
    this.settleMbrCredits(Txn.sender, mbrBefore)
  }

  /** `manageMbrCredits`, charging or refunding `account` instead of the sender. */
  protected settleMbrCredits(account: Account, mbrBefore: uint64) {
    const mbrAfter = Global.currentApplicationAddress.minBalance
    if (mbrAfter === mbrBefore) return
    else if (mbrAfter > mbrBefore) {
      const creditNeeded: uint64 = mbrAfter - mbrBefore
      const userCredit = this.userCredits(account).get({ default: 0 })
      loggedAssert(userCredit >= creditNeeded, errCredit)
      this.userCredits(account).value = userCredit - creditNeeded
    } else {
      const creditToReturn: uint64 = mbrBefore - mbrAfter
      loggedAssert(this.userCredits(account).exists, errReceiver)
      this.userCredits(account).value += creditToReturn
    }
  }

  /**
   * Deposit MBR credits for an account. The payment amount becomes the credit; opening
   * the creditor's credit box is paid out of the deposit itself, so a first deposit nets
   * amount minus the box MBR — whoever sends it.
   * @param creditor Account to credit (need not be the sender)
   * @param txn Payment to the contract; its amount is the credit received
   */
  public depositCredits(creditor: Account, txn: gtxn.PaymentTxn) {
    loggedAssert(txn.receiver === Global.currentApplicationAddress, errReceiver)
    loggedAssert(txn.amount > 0, errAmt)
    const current = this.userCredits(creditor).get({ default: 0 })

    const mbrBefore = Global.currentApplicationAddress.minBalance
    this.userCredits(creditor).value = current + txn.amount
    this.settleMbrCredits(creditor, mbrBefore)
  }

  /**
   * Log each account's credit balance (a big-endian uint64) in input order — an empty
   * log line means the account has no credit box (unambiguous: an existing box logs 8
   * bytes even at zero balance). Readonly; meant to be simulated with allowMoreLogging
   * to batch-fetch many balances in one call.
   */
  @readonly
  public logCredits(accounts: Account[]): void {
    for (const account of accounts) {
      const box = this.userCredits(account)
      if (box.exists) {
        log(op.itob(box.value))
      } else {
        log(Bytes())
      }
    }
  }

  /**
   * Withdraw all remaining MBR credits for the sender. Deletes the credit box, so the
   * MBR locked for the box itself is refunded too. The inner payment carries zero fee —
   * callers must cover it with fee pooling (1000 µA extra fee).
   */
  public withdrawCredits() {
    const mbrBefore = Global.currentApplicationAddress.minBalance
    // zero credit is fine — it still represents the MBR locked in the credit box
    loggedAssert(this.userCredits(Txn.sender).exists, errAmt)
    const credit: uint64 = this.userCredits(Txn.sender).value

    this.userCredits(Txn.sender).delete()
    const mbrAfter = Global.currentApplicationAddress.minBalance
    const finalCredit: uint64 = credit + (mbrBefore - mbrAfter)

    itxn
      .payment({
        receiver: Txn.sender,
        amount: finalCredit,
      })
      .submit()
  }
}
