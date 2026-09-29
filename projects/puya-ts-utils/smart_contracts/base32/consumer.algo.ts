import { Account, bytes, Contract, ensureBudget, OpUpFeeSource } from '@algorandfoundation/algorand-typescript'
import { base32Encode, encodeAddress } from '../../src/base32.algo'

/**
 * Exercises {@link base32Encode} the way a real contract would.
 *
 * This exists to give the test suites something to call, and doubles as the
 * worked example for both of them.
 */
export class Base32Consumer extends Contract {
  /**
   * Encode arbitrary bytes and hand the result back to the caller.
   *
   * Nothing is done here about the opcode budget, so this method encodes what
   * the 700 opcodes an application call starts with will stretch to: 30
   * bytes. See {@link encodeAddress} for the other way round.
   */
  public encode(data: bytes): string {
    return base32Encode(data)
  }

  /** Spell out an account the way the rest of Algorand writes it down. */
  public encodeAddress(account: Account): string {
    // Encoding 36 bytes costs more than the 700 opcodes this call starts with,
    // so buy another 700 before setting off. The subroutine will not do this
    // for you: it takes an inner transaction and a fee, which is the caller's
    // business to decide. `GroupCredit` takes that fee out of the group's
    // excess, so the caller covers it by sending 1000 µALGO of extra fee.
    ensureBudget(1200, OpUpFeeSource.GroupCredit)

    return encodeAddress(account)
  }
}
