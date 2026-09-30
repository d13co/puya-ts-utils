import { Config } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import { Address } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { CreateAccountConsumerFactory } from '../artifacts/create_account/CreateAccountConsumerClient'

/** Extra fee for the three inner transactions: the create/delete, its nested rekey, and the funding payment. */
const MINT_FEE = AlgoAmount.MicroAlgo(3000)

const MIN_BALANCE = 100_000n

describe('minting subroutines', () => {
  const localnet = algorandFixture()
  beforeAll(() => {
    Config.configure({
      debug: true,
      // traceAll: true,
    })
  })
  beforeEach(localnet.newScope)

  /** A deployed consumer with enough balance to pay minimum balances out of. */
  const deployConsumer = async (account: Address) => {
    const factory = localnet.algorand.client.getTypedAppFactory(CreateAccountConsumerFactory, {
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

  describe('createUnfundedAccount', () => {
    test('mints an account rekeyed to the calling application', async () => {
      const { algorand, testAccount } = localnet.context
      const consumer = await deployConsumer(testAccount.addr)

      const { return: minted } = await consumer.send.mintAndFund({ args: [], extraFee: MINT_FEE })

      const info = await algorand.account.getInformation(minted!)
      expect(info.authAddr?.toString()).toBe(consumer.appAddress.toString())
      expect(info.balance.microAlgo).toBe(MIN_BALANCE)
    })

    test('leaves the minimum balance for the caller to settle', async () => {
      const { algorand, testAccount } = localnet.context
      const consumer = await deployConsumer(testAccount.addr)
      const before = await algorand.account.getInformation(consumer.appAddress)

      await consumer.send.mintAndFund({ args: [], extraFee: MINT_FEE })

      const after = await algorand.account.getInformation(consumer.appAddress)
      expect(before.balance.microAlgo - after.balance.microAlgo).toBe(MIN_BALANCE)
    })

    test('leaves no application behind', async () => {
      const { algorand, testAccount } = localnet.context
      const consumer = await deployConsumer(testAccount.addr)

      const result = await consumer.send.mintAndFund({ args: [], extraFee: MINT_FEE })

      const created = result.confirmation.innerTxns?.[0].applicationIndex
      expect(created).toBeDefined()
      await expect(algorand.app.getById(created!)).rejects.toThrow()
    })

    test('records the minted account in state', async () => {
      const { testAccount } = localnet.context
      const consumer = await deployConsumer(testAccount.addr)

      const { return: minted } = await consumer.send.mintAndFund({ args: [], extraFee: MINT_FEE })

      expect(await consumer.state.global.minted()).toBe(minted)
    })

    test('mints a different account each time', async () => {
      const { testAccount } = localnet.context
      const consumer = await deployConsumer(testAccount.addr)

      const first = await consumer.send.mintAndFund({ args: [], extraFee: MINT_FEE })
      const second = await consumer.send.mintAndFund({ args: [], extraFee: MINT_FEE })

      expect(first.return).not.toBe(second.return)
    })
  })

  describe('createFundedAccount', () => {
    test('settles the minimum balance out of the application escrow', async () => {
      const { algorand, testAccount } = localnet.context
      const consumer = await deployConsumer(testAccount.addr)
      const before = await algorand.account.getInformation(consumer.appAddress)

      const { return: minted } = await consumer.send.mintFundedBy({
        args: { fundingAccount: consumer.appAddress.toString() },
        extraFee: MINT_FEE,
      })

      const info = await algorand.account.getInformation(minted!)
      expect(info.authAddr?.toString()).toBe(consumer.appAddress.toString())
      expect(info.balance.microAlgo).toBe(MIN_BALANCE)

      const after = await algorand.account.getInformation(consumer.appAddress)
      expect(before.balance.microAlgo - after.balance.microAlgo).toBe(MIN_BALANCE)
    })

    test('settles the minimum balance out of an account rekeyed to the application', async () => {
      const { algorand, testAccount } = localnet.context
      const consumer = await deployConsumer(testAccount.addr)

      // An ordinary account signed over to the application, which can then send
      // from it without holding its key.
      const funder = algorand.account.random()
      await algorand.send.payment({
        sender: testAccount.addr,
        receiver: funder.addr,
        amount: AlgoAmount.Algo(1),
      })
      await algorand.account.rekeyAccount(funder.addr, consumer.appAddress)

      const funderBefore = await algorand.account.getInformation(funder.addr)
      const appBefore = await algorand.account.getInformation(consumer.appAddress)

      const { return: minted } = await consumer.send.mintFundedBy({
        args: { fundingAccount: funder.addr.toString() },
        extraFee: MINT_FEE,
      })

      const info = await algorand.account.getInformation(minted!)
      expect(info.authAddr?.toString()).toBe(consumer.appAddress.toString())
      expect(info.balance.microAlgo).toBe(MIN_BALANCE)

      // The minimum balance came out of the rekeyed account, not the application.
      const funderAfter = await algorand.account.getInformation(funder.addr)
      const appAfter = await algorand.account.getInformation(consumer.appAddress)
      expect(funderBefore.balance.microAlgo - funderAfter.balance.microAlgo).toBe(MIN_BALANCE)
      expect(appAfter.balance.microAlgo).toBe(appBefore.balance.microAlgo)
    })

    test('refuses an account that is not signed over to the application', async () => {
      const { algorand, testAccount, generateAccount } = localnet.context
      const consumer = await deployConsumer(testAccount.addr)
      const stranger = await generateAccount({ initialFunds: AlgoAmount.Algo(1) })

      await expect(
        consumer.send.mintFundedBy({
          args: { fundingAccount: stranger.addr.toString() },
          extraFee: MINT_FEE,
        }),
      ).rejects.toThrow(/unauthorized/i)
    })
  })

  describe('the minted account', () => {
    test('can be spent from by the application', async () => {
      const { algorand, testAccount, generateAccount } = localnet.context
      const recipient = await generateAccount({ initialFunds: AlgoAmount.MicroAlgo(0) })
      const consumer = await deployConsumer(testAccount.addr)

      const { return: minted } = await consumer.send.mintAndFund({ args: [], extraFee: MINT_FEE })
      // Top the escrow up beyond its minimum so there is something to send.
      await algorand.send.payment({
        sender: testAccount.addr,
        receiver: minted!,
        amount: AlgoAmount.MicroAlgo(300_000),
      })

      await consumer.send.spend({
        args: { receiver: recipient.addr.toString(), amount: 200_000 },
        extraFee: AlgoAmount.MicroAlgo(1000),
      })

      const info = await algorand.account.getInformation(recipient.addr)
      expect(info.balance.microAlgo).toBe(200_000n)
    })

    test('cannot be spent from by anybody else', async () => {
      const { algorand, testAccount, generateAccount } = localnet.context
      const stranger = await generateAccount({ initialFunds: AlgoAmount.Algo(1) })
      const consumer = await deployConsumer(testAccount.addr)

      const { return: minted } = await consumer.send.mintAndFund({ args: [], extraFee: MINT_FEE })
      await algorand.send.payment({
        sender: testAccount.addr,
        receiver: minted!,
        amount: AlgoAmount.MicroAlgo(300_000),
      })

      const impostor = algorand.account.rekeyed(minted!, stranger)
      await expect(
        algorand.send.payment({
          sender: impostor.addr,
          signer: impostor.signer,
          receiver: stranger.addr,
          amount: AlgoAmount.MicroAlgo(1),
        }),
      ).rejects.toThrow(/authorized by/)
    })
  })
})
