import { Config } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import { Address } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { MbrManagerConsumerClient, MbrManagerConsumerFactory } from '../artifacts/mbr_manager/MbrManagerConsumerClient'

/** 2500 + 400 * (33-byte 'c' + pubkey name + 8-byte value) */
const CREDIT_BOX_MBR = 18_900n

/** 2500 + 400 * (33-byte 'e' + pubkey name + 1-byte value) */
const ENTRY_BOX_MBR = 16_100n

/** 400 per byte of box value */
const BYTE_MBR = 400n

const VALUE = new TextEncoder().encode('v')

describe('MbrManager', () => {
  const localnet = algorandFixture()
  beforeAll(() => {
    Config.configure({ debug: true })
  })
  beforeEach(localnet.newScope)

  const deploy = async (account: Address) => {
    const factory = localnet.algorand.client.getTypedAppFactory(MbrManagerConsumerFactory, {
      defaultSender: account,
    })
    const { appClient } = await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' })
    // the app account's own minimum balance
    await localnet.algorand.send.payment({ sender: account, receiver: appClient.appAddress, amount: AlgoAmount.Algo(1) })
    return appClient
  }

  const creditBox = (account: Address | string) =>
    new Uint8Array([...new TextEncoder().encode('c'), ...Address.fromString(account.toString()).publicKey])
  const entryBox = (account: Address) => new Uint8Array([...new TextEncoder().encode('e'), ...account.publicKey])

  const deposit = async (client: MbrManagerConsumerClient, sender: Address, amount: bigint, creditor: Address = sender) => {
    const txn = await localnet.algorand.createTransaction.payment({
      sender,
      receiver: client.appAddress,
      amount: AlgoAmount.MicroAlgo(amount),
    })
    await client.send.depositCredits({
      sender,
      args: { creditor: creditor.toString(), txn },
      boxReferences: [creditBox(creditor)],
    })
  }

  const credits = async (client: MbrManagerConsumerClient, account: Address) =>
    (await client.state.box.userCredits.getMap()).get(account.toString())

  describe('depositCredits', () => {
    test('charges the new credit box to the deposit', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)

      await deposit(client, testAccount, 500_000n)

      expect(await credits(client, testAccount)).toBe(500_000n - CREDIT_BOX_MBR)
    })

    test('accumulates without charging the box again', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)

      await deposit(client, testAccount, 300_000n)
      await deposit(client, testAccount, 200_000n)

      expect(await credits(client, testAccount)).toBe(500_000n - CREDIT_BOX_MBR)
    })

    test('credits another account without the depositor holding any credits', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)
      const other = await localnet.algorand.account.random()

      await deposit(client, testAccount, 100_000n, other.addr)

      expect(await credits(client, other.addr)).toBe(100_000n - CREDIT_BOX_MBR)
      expect(await credits(client, testAccount)).toBeUndefined()
    })

    test('fails when the deposit cannot cover the credit box (CRD)', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)

      await expect(deposit(client, testAccount, CREDIT_BOX_MBR - 1n)).rejects.toThrow(/CRD/)
    })

    test('fails with the wrong receiver (RCV)', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)
      const txn = await localnet.algorand.createTransaction.payment({
        sender: testAccount,
        receiver: testAccount,
        amount: AlgoAmount.MicroAlgo(100_000),
      })

      await expect(
        client.send.depositCredits({ args: { creditor: testAccount.toString(), txn }, boxReferences: [creditBox(testAccount)] }),
      ).rejects.toThrow(/RCV/)
    })

    test('fails with a zero amount (AMT)', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)

      await expect(deposit(client, testAccount, 0n)).rejects.toThrow(/AMT/)
    })
  })

  describe('manageMbrCredits', () => {
    const put = (client: MbrManagerConsumerClient, sender: Address, value = VALUE) =>
      client.send.put({ sender, args: { value }, boxReferences: [creditBox(sender), entryBox(sender)] })

    test('charges a box the method creates to the sender', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)
      await deposit(client, testAccount, 100_000n)

      await put(client, testAccount)

      expect(await credits(client, testAccount)).toBe(100_000n - CREDIT_BOX_MBR - ENTRY_BOX_MBR)
    })

    test('refunds a box the method deletes to the sender', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)
      await deposit(client, testAccount, 100_000n)
      await put(client, testAccount)

      await client.send.remove({ args: {}, boxReferences: [creditBox(testAccount), entryBox(testAccount)] })

      expect(await credits(client, testAccount)).toBe(100_000n - CREDIT_BOX_MBR)
    })

    test('charges a value grown in place, and refunds one shrunk', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)
      await deposit(client, testAccount, 100_000n)
      await put(client, testAccount)

      await put(client, testAccount, new TextEncoder().encode('vvvv'))
      expect(await credits(client, testAccount)).toBe(100_000n - CREDIT_BOX_MBR - ENTRY_BOX_MBR - 3n * BYTE_MBR)

      await put(client, testAccount, new TextEncoder().encode('vv'))
      expect(await credits(client, testAccount)).toBe(100_000n - CREDIT_BOX_MBR - ENTRY_BOX_MBR - BYTE_MBR)
    })

    test('fails when the sender has no credits (CRD)', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)

      await expect(put(client, testAccount)).rejects.toThrow(/CRD/)
    })
  })

  describe('logCredits', () => {
    test('logs each balance in order, empty for accounts without a box', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)
      const other = await localnet.algorand.account.random()
      await deposit(client, testAccount, 100_000n)

      const result = await client
        .newGroup()
        .logCredits({
          args: { accounts: [testAccount.toString(), other.addr.toString()] },
          boxReferences: [creditBox(testAccount), creditBox(other.addr)],
        })
        .simulate({ allowUnnamedResources: true })
      const logs = result.confirmations[0].logs!

      expect(Buffer.from(logs[0]).readBigUInt64BE()).toBe(100_000n - CREDIT_BOX_MBR)
      expect(logs[1].length).toBe(0)
    })
  })

  describe('withdrawCredits', () => {
    test('pays out the credits plus the freed box MBR and deletes the box', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)
      await deposit(client, testAccount, 500_000n)

      const result = await client.send.withdrawCredits({
        args: {},
        boxReferences: [creditBox(testAccount)],
        extraFee: AlgoAmount.MicroAlgo(1000),
      })

      expect(result.confirmation.innerTxns![0].txn.txn.payment!.amount).toBe(500_000n)
      expect(await credits(client, testAccount)).toBeUndefined()
    })

    test('fails without a prior deposit (AMT)', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)

      await expect(
        client.send.withdrawCredits({ args: {}, boxReferences: [creditBox(testAccount)], extraFee: AlgoAmount.MicroAlgo(1000) }),
      ).rejects.toThrow(/AMT/)
    })
  })
})
