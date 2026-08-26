import {
  abimethod,
  Account,
  arc4,
  Contract,
  Global,
  itxn,
  OnCompleteAction,
  Txn,
} from '@algorandfoundation/algorand-typescript'

/**
 * Mints a fresh, standalone Algorand account out of an application escrow.
 *
 * The application is created and deleted by one and the same call. While it
 * briefly exists it rekeys its own escrow to whoever called it, so once the call
 * completes the application is gone but its address survives as an ordinary
 * account — one whose private key was never generated and so cannot be held by
 * anyone — under the caller's authority.
 *
 * This is built to be driven by another contract, through
 * {@link createUnfundedAccount} or {@link createFundedAccount}.
 */
export class CreateAccount extends Contract {
  /**
   * Rekey the escrow to the caller and hand back its address.
   *
   * The escrow ends this call carrying an auth address, which obliges it to hold
   * the 0.1 ALGO minimum balance. It has nothing yet, so the caller has to pay
   * that in before the call it is nested inside comes to an end.
   */
  @abimethod({ onCreate: 'require', allowActions: ['DeleteApplication'] })
  public createAccount(): Account {
    const escrow = Global.currentApplicationAddress

    itxn
      .payment({
        receiver: escrow,
        amount: 0,
        rekeyTo: Txn.sender,
        fee: 0,
      })
      .submit()

    return escrow
  }
}

/**
 * Mint an account that only the calling contract can authorise, and return it.
 *
 * Import this into a contract and call it like any other subroutine:
 *
 * ```ts
 * const escrow = createUnfundedAccount()
 * itxn.payment({ receiver: escrow, amount: Global.minBalance, fee: 0 }).submit()
 * ```
 *
 * It creates and deletes {@link CreateAccount} in a single inner application
 * call, which rekeys that application's escrow to this contract on the way past.
 *
 * The returned account is empty and owes the 0.1 ALGO minimum balance, so the
 * caller must fund it before returning. There is no rush within the call itself:
 * minimum balances are checked once, when the top-level application call ends,
 * rather than after each inner transaction — so the escrow is free to sit below
 * its minimum in between. {@link createFundedAccount} settles it for you.
 *
 * Both inner transactions are submitted with a zero fee, so the caller needs to
 * cover them out of the fee pool: budget for the rekey and the application call
 * that carries it.
 */
export function createUnfundedAccount(): Account {
  return arc4.compileArc4(CreateAccount).call.createAccount({
    onCompletion: OnCompleteAction.DeleteApplication,
    fee: 0,
  }).returnValue
}

/**
 * Mint an account and settle its minimum balance out of `fundingAccount`.
 *
 * ```ts
 * const escrow = createFundedAccount(Global.currentApplicationAddress)
 * ```
 *
 * `fundingAccount` has to be one this contract can send from: either its own
 * escrow, or an account rekeyed to it. Anything else is rejected by the AVM when
 * the payment is submitted.
 *
 * Costs one inner transaction more than {@link createUnfundedAccount}, so budget
 * for three out of the fee pool: the rekey, the application call that carries
 * it, and the funding payment.
 */
export function createFundedAccount(fundingAccount: Account): Account {
  const escrow = createUnfundedAccount()

  itxn
    .payment({
      sender: fundingAccount,
      receiver: escrow,
      amount: Global.minBalance,
      fee: 0,
    })
    .submit()

  return escrow
}
