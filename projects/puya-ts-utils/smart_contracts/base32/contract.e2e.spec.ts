import { Config } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import { Address } from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { Base32ConsumerFactory } from '../artifacts/base32/Base32ConsumerClient'
import { randomBytes, referenceEncode } from './reference'

describe('base32Encode on LocalNet', () => {
  const localnet = algorandFixture()
  beforeAll(() => {
    Config.configure({
      debug: true,
      // traceAll: true,
    })
  })
  beforeEach(localnet.newScope)

  const deployConsumer = async (account: Address) => {
    const factory = localnet.algorand.client.getTypedAppFactory(Base32ConsumerFactory, {
      defaultSender: account,
    })
    const { appClient } = await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' })
    return appClient
  }

  test('encodes what an off-chain implementation encodes, whatever the tail', async () => {
    const { testAccount } = localnet.context
    const consumer = await deployConsumer(testAccount.addr)

    // One input per possible remainder: five bytes fill a group exactly, and
    // the others leave one to four bytes over for the padding to finish.
    for (const length of [0, 1, 2, 3, 4, 5, 11]) {
      const data = randomBytes(length)

      const { return: encoded } = await consumer.send.encode({ args: { data } })

      expect(encoded).toBe(referenceEncode(data))
    }
  })

  test('writes an account out the way the network does', async () => {
    const { testAccount } = localnet.context
    const consumer = await deployConsumer(testAccount.addr)

    const { return: encoded } = await consumer.send.encodeAddress({
      args: { account: testAccount.addr.toString() },
      // Covers the inner application call the method buys its opcode budget with.
      extraFee: AlgoAmount.MicroAlgo(1000),
    })

    expect(encoded).toBe(testAccount.addr.toString())
  })

  test('costs the documented 94 opcodes per five-byte group', async () => {
    const { testAccount } = localnet.context
    const consumer = await deployConsumer(testAccount.addr)

    const budgetFor = async (length: number) => {
      const { simulateResponse } = await consumer
        .newGroup()
        .encode({ args: { data: randomBytes(length) } })
        // Simulate hands out the budget for free, so the cost can be read off
        // inputs a real call could not afford.
        .simulate({ extraOpcodeBudget: 20_000 })

      return Number(simulateResponse.txnGroups[0].appBudgetConsumed)
    }

    const [twoGroups, eightGroups] = [await budgetFor(10), await budgetFor(36)]

    expect((eightGroups - twoGroups) / 6).toBeCloseTo(94, 0)
    // Which is why a 36-byte address does not fit in one call's 700 opcodes.
    expect(eightGroups).toBeGreaterThan(700)
    expect(eightGroups).toBeLessThan(900)
  })

  test('encodes up to the documented 30 bytes on one call’s budget, and no more', async () => {
    const { testAccount } = localnet.context
    const consumer = await deployConsumer(testAccount.addr)

    const data = randomBytes(30)
    const { return: encoded } = await consumer.send.encode({ args: { data } })
    expect(encoded).toBe(referenceEncode(data))

    await expect(consumer.send.encode({ args: { data: randomBytes(31) } })).rejects.toThrow(/budget exceeded/)
  })
})
