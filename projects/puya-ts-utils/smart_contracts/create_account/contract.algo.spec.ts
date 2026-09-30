import { Account, Global, OnCompleteAction } from '@algorandfoundation/algorand-typescript'
import { ApplicationSpy, TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { afterEach, describe, expect, it } from 'vitest'
import { CreateAccountConsumer } from './consumer.algo'
import { CreateAccount } from '../../src/createAccount.algo'

const ctx = new TestExecutionContext()
afterEach(() => ctx.reset())

describe('CreateAccount contract', () => {

  /** The one call the contract accepts: a creation that deletes itself again. */
  const createAndDelete = (contract: CreateAccount, caller = ctx.defaultSender) =>
    ctx.txn
      .createScope([
        ctx.any.txn.applicationCall({
          appId: contract,
          sender: caller,
          onCompletion: OnCompleteAction.DeleteApplication,
        }),
      ])
      .execute(() => contract.createAccount())

  it('returns the escrow address', () => {
    const contract = ctx.contract.create(CreateAccount)

    const escrow = createAndDelete(contract)

    expect(escrow.bytes).toEqual(ctx.ledger.getApplicationForContract(contract).address.bytes)
  })

  it('rekeys the escrow to the calling contract', () => {
    // Called through an inner transaction, the sender is the caller's escrow.
    const caller = ctx.any.account()
    const contract = ctx.contract.create(CreateAccount)

    const escrow = createAndDelete(contract, caller)

    const rekey = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
    expect(rekey.rekeyTo.bytes).toEqual(caller.bytes)
    expect(rekey.receiver.bytes).toEqual(escrow.bytes)
    expect(rekey.amount).toEqual(0)
  })

  it('leaves the rekey for the calling contract to pay for', () => {
    const contract = ctx.contract.create(CreateAccount)

    createAndDelete(contract)

    expect(ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn().fee).toEqual(0)
  })

  it('gives each application instance a different escrow', () => {
    const first = ctx.contract.create(CreateAccount)
    const second = ctx.contract.create(CreateAccount)

    expect(createAndDelete(first).bytes).not.toEqual(createAndDelete(second).bytes)
  })

  it.each([OnCompleteAction.NoOp, OnCompleteAction.OptIn, OnCompleteAction.UpdateApplication])(
    'refuses on completion %i',
    (onCompletion) => {
      const contract = ctx.contract.create(CreateAccount)

      expect(() =>
        ctx.txn
          .createScope([ctx.any.txn.applicationCall({ appId: contract, onCompletion })])
          .execute(() => contract.createAccount()),
      ).toThrow(/on_completion/)
    },
  )
})

/**
 * Stands in for the inner create/delete call, which cannot run for real off
 * chain, and reports back how it was asked for.
 */
const stubCreateAccount = (escrow: Account) => {
  const calls: OnCompleteAction[] = []
  const spy = new ApplicationSpy(CreateAccount)
  spy.on.createAccount((itxnContext) => {
    calls.push(itxnContext.onCompletion)
    itxnContext.setReturnValue(escrow)
  })
  ctx.addApplicationSpy(spy)
  return calls
}

const mintAndFund = (consumer: CreateAccountConsumer) =>
  ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: consumer })]).execute(() => consumer.mintAndFund())

describe('createUnfundedAccount subroutine', () => {
  it('hands the calling contract the account it minted', () => {
    const escrow = ctx.any.account()
    stubCreateAccount(escrow)
    const consumer = ctx.contract.create(CreateAccountConsumer)

    const minted = mintAndFund(consumer)

    expect(minted.bytes).toEqual(escrow.bytes)
    expect(consumer.minted.value.bytes).toEqual(escrow.bytes)
  })

  it('creates the account by deleting the application that made it', () => {
    const calls = stubCreateAccount(ctx.any.account())
    const consumer = ctx.contract.create(CreateAccountConsumer)

    mintAndFund(consumer)

    expect(calls).toEqual([OnCompleteAction.DeleteApplication])
  })

  it('leaves the caller to cover the minimum balance', () => {
    const escrow = ctx.any.account()
    stubCreateAccount(escrow)
    const consumer = ctx.contract.create(CreateAccountConsumer)

    mintAndFund(consumer)

    const funding = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
    expect(funding.receiver.bytes).toEqual(escrow.bytes)
    expect(funding.amount).toEqual(Global.minBalance)
  })
})

describe('createFundedAccount subroutine', () => {
  const mintFundedBy = (consumer: CreateAccountConsumer, fundingAccount: Account) =>
    ctx.txn
      .createScope([ctx.any.txn.applicationCall({ appId: consumer })])
      .execute(() => consumer.mintFundedBy(fundingAccount))

  it('covers the minimum balance out of the funding account', () => {
    const escrow = ctx.any.account()
    const funder = ctx.any.account()
    stubCreateAccount(escrow)
    const consumer = ctx.contract.create(CreateAccountConsumer)

    const minted = mintFundedBy(consumer, funder)

    expect(minted.bytes).toEqual(escrow.bytes)
    const funding = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
    expect(funding.sender.bytes).toEqual(funder.bytes)
    expect(funding.receiver.bytes).toEqual(escrow.bytes)
    expect(funding.amount).toEqual(Global.minBalance)
  })

  it('mints the account the same way as its unfunded counterpart', () => {
    const calls = stubCreateAccount(ctx.any.account())
    const consumer = ctx.contract.create(CreateAccountConsumer)

    mintFundedBy(consumer, ctx.any.account())

    expect(calls).toEqual([OnCompleteAction.DeleteApplication])
  })
})

describe('the minted account', () => {
  it('is spendable by the calling contract', () => {
    const escrow = ctx.any.account()
    const receiver = ctx.any.account()
    stubCreateAccount(escrow)
    const consumer = ctx.contract.create(CreateAccountConsumer)
    mintAndFund(consumer)

    ctx.txn
      .createScope([ctx.any.txn.applicationCall({ appId: consumer })])
      .execute(() => consumer.spend(receiver, 1000))

    const payment = ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()
    expect(payment.sender.bytes).toEqual(escrow.bytes)
    expect(payment.receiver.bytes).toEqual(receiver.bytes)
    expect(payment.amount).toEqual(1000)
  })
})
