import { Config } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import { Address } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { TxnCounterConsumerFactory } from '../artifacts/txn_counter/TxnCounterConsumerClient'

/** The one inner transaction a read costs, when the caller is the one paying. */
const READ_FEE = AlgoAmount.MicroAlgo(1000)

/** What the fee payer is charged when it pays for the read itself. */
const MIN_TXN_FEE = 1000n

describe('getTxnCounter', () => {
  const localnet = algorandFixture()
  beforeAll(() => {
    Config.configure({
      debug: true,
      // traceAll: true,
    })
  })
  beforeEach(localnet.newScope)

  /** A deployed consumer with a balance to pay inner fees out of. */
  const deployConsumer = async (account: Address) => {
    const factory = localnet.algorand.client.getTypedAppFactory(TxnCounterConsumerFactory, {
      defaultSender: account,
    })
    const { appClient } = await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' })
    await localnet.algorand.send.payment({
      sender: account,
      receiver: appClient.appAddress,
      amount: AlgoAmount.Algo(1),
    })
    return appClient
  }

  describe('paid for out of the fee pool', () => {
    test('returns the id one past the application it created', async () => {
      const { testAccount } = localnet.context
      const consumer = await deployConsumer(testAccount.addr)

      const result = await consumer.send.read({ args: [], extraFee: READ_FEE })

      const probe = result.confirmation.innerTxns?.[0].applicationIndex
      expect(probe).toBeDefined()
      expect(result.return).toBe(probe! + 1n)
    })

    test('leaves no application behind', async () => {
      const { algorand, testAccount } = localnet.context
      const consumer = await deployConsumer(testAccount.addr)

      const result = await consumer.send.read({ args: [], extraFee: READ_FEE })

      const probe = result.confirmation.innerTxns?.[0].applicationIndex
      await expect(algorand.app.getById(probe!)).rejects.toThrow()
    })

    test('advances as the network does', async () => {
      const { testAccount } = localnet.context
      const consumer = await deployConsumer(testAccount.addr)

      const first = await consumer.send.read({ args: [], extraFee: READ_FEE })
      const second = await consumer.send.read({ args: [], extraFee: READ_FEE })

      expect(second.return!).toBeGreaterThan(first.return!)
    })

    test('records the counter in state', async () => {
      const { testAccount } = localnet.context
      const consumer = await deployConsumer(testAccount.addr)

      const result = await consumer.send.read({ args: [], extraFee: READ_FEE })

      expect(await consumer.state.global.counter()).toBe(result.return)
    })

    test('costs the application nothing', async () => {
      const { algorand, testAccount } = localnet.context
      const consumer = await deployConsumer(testAccount.addr)
      const before = await algorand.account.getInformation(consumer.appAddress)

      await consumer.send.read({ args: [], extraFee: READ_FEE })

      const after = await algorand.account.getInformation(consumer.appAddress)
      expect(after.balance.microAlgo).toBe(before.balance.microAlgo)
    })

    test('is rejected when the caller does not cover the inner transaction', async () => {
      const { testAccount } = localnet.context
      const consumer = await deployConsumer(testAccount.addr)

      await expect(consumer.send.read({ args: [] })).rejects.toThrow(/fee/i)
    })
  })

  describe('paid for by a fee payer', () => {
    test('charges the application escrow, with no extra fee from the caller', async () => {
      const { algorand, testAccount } = localnet.context
      const consumer = await deployConsumer(testAccount.addr)
      const before = await algorand.account.getInformation(consumer.appAddress)

      const result = await consumer.send.readPaidBy({
        args: { feePayer: consumer.appAddress.toString() },
      })

      const probe = result.confirmation.innerTxns?.[0].applicationIndex
      expect(result.return).toBe(probe! + 1n)

      const after = await algorand.account.getInformation(consumer.appAddress)
      expect(before.balance.microAlgo - after.balance.microAlgo).toBe(MIN_TXN_FEE)
    })

    test('charges an account rekeyed to the application', async () => {
      const { algorand, testAccount } = localnet.context
      const consumer = await deployConsumer(testAccount.addr)

      // An ordinary account signed over to the application, which can then send
      // from it without holding its key.
      const feePayer = algorand.account.random()
      await algorand.send.payment({
        sender: testAccount.addr,
        receiver: feePayer.addr,
        amount: AlgoAmount.Algo(1),
      })
      await algorand.account.rekeyAccount(feePayer.addr, consumer.appAddress)

      const payerBefore = await algorand.account.getInformation(feePayer.addr)
      const appBefore = await algorand.account.getInformation(consumer.appAddress)

      await consumer.send.readPaidBy({ args: { feePayer: feePayer.addr.toString() } })

      // The fee came out of the rekeyed account, not the application.
      const payerAfter = await algorand.account.getInformation(feePayer.addr)
      const appAfter = await algorand.account.getInformation(consumer.appAddress)
      expect(payerBefore.balance.microAlgo - payerAfter.balance.microAlgo).toBe(MIN_TXN_FEE)
      expect(appAfter.balance.microAlgo).toBe(appBefore.balance.microAlgo)
    })

    test('refuses an account that is not signed over to the application', async () => {
      const { testAccount, generateAccount } = localnet.context
      const consumer = await deployConsumer(testAccount.addr)
      const stranger = await generateAccount({ initialFunds: AlgoAmount.Algo(1) })

      await expect(
        consumer.send.readPaidBy({ args: { feePayer: stranger.addr.toString() } }),
      ).rejects.toThrow(/unauthorized/i)
    })

    test('falls back to the fee pool when given the zero address', async () => {
      const { algorand, testAccount } = localnet.context
      const consumer = await deployConsumer(testAccount.addr)
      const before = await algorand.account.getInformation(consumer.appAddress)

      const result = await consumer.send.readPaidBy({
        args: { feePayer: Address.zeroAddress().toString() },
        extraFee: READ_FEE,
      })

      const probe = result.confirmation.innerTxns?.[0].applicationIndex
      expect(result.return).toBe(probe! + 1n)

      const after = await algorand.account.getInformation(consumer.appAddress)
      expect(after.balance.microAlgo).toBe(before.balance.microAlgo)
    })
  })
})
