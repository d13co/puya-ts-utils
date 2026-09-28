import { Account, BoxMap, bytes, Global, Txn } from '@algorandfoundation/algorand-typescript'
import { MbrManager } from '../../src/mbrManager.algo'

/**
 * A minimal registry charging its boxes to the sender's MBR credits — something for
 * the test suite to call, and the worked example for `MbrManager`. Each account owns
 * the one entry keyed by its address, so only its owner can resize or delete it and
 * claim the refund.
 */
export class MbrManagerConsumer extends MbrManager {
  // 'e' prefix keeps entries disjoint from the 'c' credit boxes
  entries = BoxMap<Account, bytes>({ keyPrefix: 'e' })

  /** Store the sender's value, charging any box MBR increase to their credits. */
  public put(value: bytes) {
    const mbrBefore = Global.currentApplicationAddress.minBalance
    this.entries(Txn.sender).value = value
    this.manageMbrCredits(mbrBefore)
  }

  /** Delete the sender's value, refunding the freed box MBR to their credits. */
  public remove() {
    const mbrBefore = Global.currentApplicationAddress.minBalance
    this.entries(Txn.sender).delete()
    this.manageMbrCredits(mbrBefore)
  }
}
