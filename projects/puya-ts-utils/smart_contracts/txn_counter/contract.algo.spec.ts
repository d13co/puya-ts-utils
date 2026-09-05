import { Account, Bytes, Global, OnCompleteAction } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { afterEach, describe, expect, it } from 'vitest'
import { TxnCounterConsumer } from './consumer.algo'
import { probeStubber } from './stub-probe'

const ctx = new TestExecutionContext()
afterEach(() => ctx.reset())

/** The programs the probe application is created with. */
const PROBE_PROGRAM = Bytes.fromHex('0a8101')

const stubProbe = probeStubber(ctx)

const read = (consumer: TxnCounterConsumer) =>
  ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: consumer })]).execute(() => consumer.read())

const readPaidBy = (consumer: TxnCounterConsumer, feePayer: Account) =>
  ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: consumer })]).execute(() => consumer.readPaidBy(feePayer))

/** The inner application call the subroutine submitted. */
const probeItxn = () => ctx.txn.lastGroup.lastItxnGroup().getApplicationCallInnerTxn()

describe('getTxnCounter subroutine', () => {
  it('returns the id past the one the probe application was given', () => {
    const probe = ctx.any.application({ applicationId: 1234 })
    stubProbe(probe)
    const consumer = ctx.contract.create(TxnCounterConsumer)

    expect(read(consumer)).toEqual(1235)
  })

  it('records the counter it read in state', () => {
    stubProbe(ctx.any.application({ applicationId: 777 }))
    const consumer = ctx.contract.create(TxnCounterConsumer)

    read(consumer)

    expect(consumer.counter.value).toEqual(778)
  })

  it('reads the counter by deleting the application that measured it', () => {
    stubProbe(ctx.any.application({ applicationId: 1 }))
    const consumer = ctx.contract.create(TxnCounterConsumer)

    read(consumer)

    expect(probeItxn().onCompletion).toEqual(OnCompleteAction.DeleteApplication)
  })

  it('creates the probe with an always-approve program', () => {
    stubProbe(ctx.any.application({ applicationId: 1 }))
    const consumer = ctx.contract.create(TxnCounterConsumer)

    read(consumer)

    expect(probeItxn().approvalProgram).toEqual(PROBE_PROGRAM)
    expect(probeItxn().clearStateProgram).toEqual(PROBE_PROGRAM)
  })
})

describe('when the fee payer is the zero address', () => {
  it('leaves the inner transaction for the caller to pay for', () => {
    stubProbe(ctx.any.application({ applicationId: 1 }))
    const consumer = ctx.contract.create(TxnCounterConsumer)

    read(consumer)

    expect(probeItxn().fee).toEqual(0)
  })

  it('sends the inner transaction from the calling application', () => {
    stubProbe(ctx.any.application({ applicationId: 1 }))
    const consumer = ctx.contract.create(TxnCounterConsumer)

    read(consumer)

    expect(probeItxn().sender.bytes).toEqual(ctx.ledger.getApplicationForContract(consumer).address.bytes)
  })

  it('is reached through the fee payer argument too', () => {
    stubProbe(ctx.any.application({ applicationId: 42 }))
    const consumer = ctx.contract.create(TxnCounterConsumer)

    const counter = readPaidBy(consumer, Global.zeroAddress)

    expect(counter).toEqual(43)
    expect(probeItxn().fee).toEqual(0)
    expect(probeItxn().sender.bytes).toEqual(ctx.ledger.getApplicationForContract(consumer).address.bytes)
  })
})

describe('when a fee payer is given', () => {
  it('charges the inner transaction to the fee payer', () => {
    const feePayer = ctx.any.account()
    stubProbe(ctx.any.application({ applicationId: 9 }))
    const consumer = ctx.contract.create(TxnCounterConsumer)

    const counter = readPaidBy(consumer, feePayer)

    expect(counter).toEqual(10)
    expect(probeItxn().sender.bytes).toEqual(feePayer.bytes)
    expect(probeItxn().fee).toEqual(Global.minTxnFee)
  })
})
