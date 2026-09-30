import { AlgorandClient, Config } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import { Address, generateAccount, makeEmptyTransactionSigner } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  addDepositCredits,
  addWithdrawCredits,
  CREDIT_BOX_MBR_MICROALGOS,
  creditBoxName,
  getAllCredits,
  getCredits,
} from '../../src/mbrManagerSdk'
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

  const deploy = async (account: Address, funding = AlgoAmount.Algo(1)) => {
    const factory = localnet.algorand.client.getTypedAppFactory(MbrManagerConsumerFactory, {
      defaultSender: account,
    })
    const { appClient } = await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' })
    // the app account's own minimum balance
    await localnet.algorand.send.payment({ sender: account, receiver: appClient.appAddress, amount: funding })
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

    test('fails when the deposit cannot cover the credit box (crd)', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)

      await expect(deposit(client, testAccount, CREDIT_BOX_MBR - 1n)).rejects.toThrow(/crd/)
    })

    test('fails with the wrong receiver (rcv)', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)
      const txn = await localnet.algorand.createTransaction.payment({
        sender: testAccount,
        receiver: testAccount,
        amount: AlgoAmount.MicroAlgo(100_000),
      })

      await expect(
        client.send.depositCredits({ args: { creditor: testAccount.toString(), txn }, boxReferences: [creditBox(testAccount)] }),
      ).rejects.toThrow(/rcv/)
    })

    test('fails with a zero amount (amt)', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)

      await expect(deposit(client, testAccount, 0n)).rejects.toThrow(/amt/)
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

    test('fails when the sender has no credits (crd)', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)

      await expect(put(client, testAccount)).rejects.toThrow(/crd/)
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

    test('fails without a prior deposit (amt)', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)

      await expect(
        client.send.withdrawCredits({ args: {}, boxReferences: [creditBox(testAccount)], extraFee: AlgoAmount.MicroAlgo(1000) }),
      ).rejects.toThrow(/amt/)
    })
  })

  describe('mbrManagerSdk', () => {
    test('names the credit box and prices it', async () => {
      const { testAccount } = localnet.context

      expect(creditBoxName(testAccount)).toEqual(creditBox(testAccount))
      expect(creditBoxName(testAccount.publicKey)).toEqual(creditBox(testAccount))
      expect(BigInt(CREDIT_BOX_MBR_MICROALGOS)).toBe(CREDIT_BOX_MBR)
    })

    test('deposits, reads and withdraws through any MbrManager app', async () => {
      const { testAccount } = localnet.context
      const { algorand } = localnet
      const client = await deploy(testAccount)
      const app = { algorand, appId: client.appId }
      const other = await algorand.account.random()

      const group = algorand.newGroup()
      await addDepositCredits(group, { ...app, sender: testAccount, amount: AlgoAmount.MicroAlgo(100_000) })
      await addDepositCredits(group, { ...app, sender: testAccount, amount: AlgoAmount.MicroAlgo(50_000), creditor: other.addr })
      await group.send()

      expect(await getCredits(app, [testAccount, other.addr, generateAccount().addr])).toEqual([
        100_000n - CREDIT_BOX_MBR,
        50_000n - CREDIT_BOX_MBR,
        undefined,
      ])
      expect(await getAllCredits(app)).toEqual(
        new Map([
          [testAccount.toString(), 100_000n - CREDIT_BOX_MBR],
          [other.addr.toString(), 50_000n - CREDIT_BOX_MBR],
        ]),
      )

      await addWithdrawCredits(algorand.newGroup(), { ...app, sender: testAccount }).send()

      expect(await getAllCredits(app)).toEqual(new Map([[other.addr.toString(), 50_000n - CREDIT_BOX_MBR]]))
    })

    test('reads large account lists in order', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)
      const app = { algorand: localnet.algorand, appId: client.appId }
      const accounts = Array.from({ length: 130 }, () => generateAccount().addr)
      accounts[129] = testAccount
      await deposit(client, testAccount, 100_000n)

      const credits = await getCredits(app, accounts)

      expect(credits.length).toBe(130)
      expect(credits[129]).toBe(100_000n - CREDIT_BOX_MBR)
      expect(credits.slice(0, 129).every((c) => c === undefined)).toBe(true)
      expect(await getCredits({ ...app, concurrency: 1 }, accounts)).toEqual(credits)
    })

    test('reads zero and missing credits when the app is at its exact minimum balance', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount, AlgoAmount.Algo(0.1))
      const app = { algorand: localnet.algorand, appId: client.appId }
      expect(await getCredits(app, [testAccount])).toEqual([undefined])

      await deposit(client, testAccount, CREDIT_BOX_MBR)
      const info = await localnet.algorand.client.algod.accountInformation(client.appAddress).do()
      expect(info.amount).toBe(info.minBalance)
      const accounts = Array.from({ length: 130 }, () => generateAccount().addr)
      for (const index of [0, 63, 129]) accounts[index] = testAccount
      const expected = accounts.map((account) => account === testAccount ? 0n : undefined)

      expect(await getCredits(app, accounts)).toEqual(expected)
      expect(await getCredits({ ...app, concurrency: 1 }, accounts)).toEqual(expected)
      expect(await getAllCredits(app)).toEqual(new Map([[testAccount.toString(), 0n]]))
      expect(await getCredits(app, [])).toEqual([])
    })

    test('reads missing credits after withdrawal leaves the app at minimum balance', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount, AlgoAmount.Algo(0.1))
      const app = { algorand: localnet.algorand, appId: client.appId }
      await deposit(client, testAccount, 100_000n)
      await addWithdrawCredits(localnet.algorand.newGroup(), { ...app, sender: testAccount }).send()
      const info = await localnet.algorand.client.algod.accountInformation(client.appAddress).do()

      expect(info.amount).toBe(info.minBalance)
      expect(await getCredits(app, [testAccount])).toEqual([undefined])
      expect(await getAllCredits(app)).toEqual(new Map())
    })

    test('propagates a failed box request instead of returning a missing balance', async () => {
      const algorand = AlgorandClient.fromConfig({ algodConfig: { server: 'http://127.0.0.1', port: 1, token: '' } })
      await expect(getCredits({ algorand, appId: 1n }, [localnet.context.testAccount])).rejects.toThrow()
    })

    test('rejects a deposit when algod is down, without an unhandled rejection', async () => {
      const algorand = AlgorandClient.fromConfig({ algodConfig: { server: 'http://127.0.0.1', port: 1, token: '' } })
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)
      try {
        const deposit = async () =>
          (
            await addDepositCredits(algorand.newGroup(), {
              algorand,
              appId: 1n,
              sender: generateAccount().addr,
              signer: makeEmptyTransactionSigner(),
              amount: AlgoAmount.MicroAlgo(100_000),
            })
          ).build()

        await expect(deposit()).rejects.toThrow()
        // Give a stray rejection time to surface.
        await new Promise((resolve) => setTimeout(resolve, 100))
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }

      expect(unhandled).toEqual([])
    })

    test('reverts a first deposit below the credit box MBR (crd)', async () => {
      const { testAccount } = localnet.context
      const client = await deploy(testAccount)
      const app = { algorand: localnet.algorand, appId: client.appId }

      const group = await addDepositCredits(localnet.algorand.newGroup(), {
        ...app,
        sender: testAccount,
        amount: AlgoAmount.MicroAlgo(CREDIT_BOX_MBR_MICROALGOS - 1),
      })

      await expect(group.send()).rejects.toThrow(/crd/)
    })
  })
})
