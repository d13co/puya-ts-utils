import { Account, Contract, Global, GlobalState, itxn, uint64 } from '@algorandfoundation/algorand-typescript'
import { createFundedAccount, createUnfundedAccount } from '../../src/createAccount.algo'

/**
 * Exercises the minting subroutines the way a real contract would.
 *
 * This exists to give the test suites something to call, and doubles as the
 * worked example for both of them.
 */
export class CreateAccountConsumer extends Contract {
  /** The account minted by the most recent call. */
  minted = GlobalState<Account>({ key: 'minted' })

  /**
   * Mint an account and settle its minimum balance separately, out of this
   * application's own escrow.
   */
  public mintAndFund(): Account {
    const escrow = createUnfundedAccount()

    // The escrow is below its minimum balance until this lands. That is fine:
    // the ledger only checks once this application call is over.
    itxn
      .payment({
        receiver: escrow,
        amount: Global.minBalance,
        fee: 0,
      })
      .submit()

    this.minted.value = escrow
    return escrow
  }

  /**
   * Mint an account, leaving the subroutine to settle its minimum balance out of
   * `fundingAccount` — this application's escrow, or any account rekeyed to it.
   */
  public mintFundedBy(fundingAccount: Account): Account {
    const escrow = createFundedAccount(fundingAccount)

    this.minted.value = escrow
    return escrow
  }

  /**
   * Spend from the minted account.
   *
   * The escrow holds no key of its own; it is rekeyed to this application, so
   * this application is the only thing that can move its balance.
   */
  public spend(receiver: Account, amount: uint64): void {
    itxn
      .payment({
        sender: this.minted.value,
        receiver,
        amount,
        fee: 0,
      })
      .submit()
  }
}
