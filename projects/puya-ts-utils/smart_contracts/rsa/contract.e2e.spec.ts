import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import { generateAccount } from 'algosdk'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { RsaConsumerFactory } from '../artifacts/rsa/RsaConsumerClient'
import { RsaSplitConsumerComposer, RsaSplitConsumerFactory } from '../artifacts/rsa/RsaSplitConsumerClient'
import { PL_DNSKEY, ROOT_DNSKEY } from './dnskey-fixtures'
import { montgomeryHint, signWithNewKey } from './test-keys'

/** Everything a group can pool: 16 logic signatures at 20,000 each. */
const MAX_BUDGET = 320_000

const hex = (h: string) => Buffer.from(h, 'hex')

/** The root KSK's modulus: its public key field after `03 010001`. */
const ROOT_HINT = montgomeryHint(hex(ROOT_DNSKEY.publicKey).subarray(4))
const NO_HINT = new Uint8Array()

describe('RSA verification on the AVM', () => {
  const localnet = algorandFixture()
  beforeEach(localnet.newScope)

  const deployConsumer = async () => {
    const factory = localnet.algorand.client.getTypedAppFactory(RsaConsumerFactory, {
      defaultSender: localnet.context.testAccount.addr,
    })
    const { appClient } = await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' })
    return appClient
  }

  /** Simulate an RRSIG check with the budget raised, returning its result and cost. */
  const simulateRrsig = async (signature: Uint8Array, hint: Uint8Array = NO_HINT) => {
    const consumer = await deployConsumer()
    const result = await consumer
      .newGroup()
      .verifyRrsig({
        args: {
          signedData: hex(ROOT_DNSKEY.signedData),
          signature,
          publicKey: hex(ROOT_DNSKEY.publicKey),
          hint,
        },
      })
      .simulate({ extraOpcodeBudget: MAX_BUDGET, allowUnnamedResources: true })
    return {
      valid: result.returns[0],
      cost: result.simulateResponse.txnGroups[0].appBudgetConsumed!,
    }
  }

  test('accepts the root KSK signature over the root DNSKEY RRset', async () => {
    const { valid, cost } = await simulateRrsig(hex(ROOT_DNSKEY.signature))

    expect(valid).toBe(true)
    console.log(`RSA-2048, e = 65537: ${cost} opcode budget`)
    expect(cost).toBeLessThan(MAX_BUDGET)
  })

  test('accepts it for a fraction of the budget given the Montgomery hint', async () => {
    const { valid, cost } = await simulateRrsig(hex(ROOT_DNSKEY.signature), ROOT_HINT)

    expect(valid).toBe(true)
    console.log(`RSA-2048, e = 65537, hint: ${cost} opcode budget`)
    expect(cost).toBeLessThan(100_000)
  })

  test('rejects the signature with one byte flipped', async () => {
    const signature = hex(ROOT_DNSKEY.signature)
    signature[100] ^= 0x01

    const { valid } = await simulateRrsig(signature)

    expect(valid).toBe(false)
  })

  test.each([
    [1024, 65537],
    [1280, 65537],
    [2047, 65537],
    [2048, 3],
    [3072, 65537],
  ])('RSA-%i with e = %i', async (bits, e) => {
    const consumer = await deployConsumer()
    const { modulus, exponent, digest, signature } = signWithNewKey(bits, e, 'sha256')
    const hint = montgomeryHint(modulus)

    const result = await consumer
      .newGroup()
      .verifySha256({ args: { digest, signature, modulus, exponent, hint } })
      .simulate({ extraOpcodeBudget: MAX_BUDGET, allowUnnamedResources: true })
    const cost = result.simulateResponse.txnGroups[0].appBudgetConsumed!

    console.log(`RSA-${bits}, e = ${e}, hint: ${cost} opcode budget`)
    expect(result.returns[0]).toBe(true)
    expect(cost).toBeLessThan(MAX_BUDGET)
  })

  test('RSA-4096 is over what one group can pool', async () => {
    const consumer = await deployConsumer()
    const { modulus, exponent, digest, signature } = signWithNewKey(4096, 65537, 'sha256')

    await expect(
      consumer
        .newGroup()
        .verifySha256({ args: { digest, signature, modulus, exponent, hint: montgomeryHint(modulus) } })
        .simulate({ extraOpcodeBudget: MAX_BUDGET, allowUnnamedResources: true }),
    ).rejects.toThrow(/budget exceeded/)
  })

  describe('hosted in a logic signature', () => {
    const createAsset = async () => {
      const { algorand, testAccount } = localnet.context
      return (await algorand.send.assetCreate({ sender: testAccount, total: 1n })).assetId
    }

    /** The verifier's program, and a group that pools enough budget to run it. */
    const verifyInLsig = async (
      signature: Uint8Array,
      groupSize: number,
      hint: Uint8Array = NO_HINT,
      tamper: {
        note?: Uint8Array
        rekeyTo?: string
        closeRemainderTo?: string
        amount?: number
        fee?: number
        asAssetOptIn?: boolean
      } = {},
    ) => {
      const { algorand, testAccount } = localnet.context
      const teal = readFileSync(join(__dirname, '../artifacts/rsa/RsaSha256Verifier.teal'), 'utf8')
      const { compiledBase64ToBytes: program } = await algorand.app.compileTeal(teal)
      const publicKey = hex(ROOT_DNSKEY.publicKey)
      const digest = createHash('sha256').update(hex(ROOT_DNSKEY.signedData)).digest()
      const verifier = algorand.account.logicsig(
        program,
        [digest, signature, publicKey, hint].map((a) => new Uint8Array(a)),
      )
      const note = Buffer.concat([createHash('sha256').update(publicKey).digest(), digest])

      // The verifier sends nothing and pays no fee, and its note says what it
      // checked; the rest of the group is there for the budget it pools, and one
      // of them covers every fee.
      const common = { sender: verifier, staticFee: AlgoAmount.MicroAlgo(tamper.fee ?? 0), note: new Uint8Array(tamper.note ?? note) }
      const group = tamper.asAssetOptIn
        ? algorand.newGroup().addAssetOptIn({ ...common, assetId: await createAsset() })
        : algorand.newGroup().addPayment({
            ...common,
            receiver: verifier,
            amount: AlgoAmount.MicroAlgo(tamper.amount ?? 0),
            rekeyTo: tamper.rekeyTo,
            closeRemainderTo: tamper.closeRemainderTo,
          })
      for (let i = 1; i < groupSize; i++) {
        group.addPayment({
          sender: testAccount,
          receiver: testAccount,
          amount: AlgoAmount.MicroAlgo(0),
          note: `pool ${i}`,
          staticFee: AlgoAmount.MicroAlgo(i === 1 ? 1000 * groupSize : 0),
        })
      }
      return { program, send: () => group.send() }
    }

    test('verifies the root KSK signature, pooling budget across 7 transactions', async () => {
      const { program, send } = await verifyInLsig(hex(ROOT_DNSKEY.signature), 7)

      console.log(`RsaSha256Verifier program: ${program.length} bytes`)
      await expect(send()).resolves.toBeDefined()
    })

    test('verifies it across 5 transactions given the Montgomery hint', async () => {
      const { send } = await verifyInLsig(hex(ROOT_DNSKEY.signature), 5, ROOT_HINT)

      await expect(send()).resolves.toBeDefined()
    })

    test('rejects the signature with one byte flipped', async () => {
      const signature = hex(ROOT_DNSKEY.signature)
      signature[100] ^= 0x01
      const { send } = await verifyInLsig(signature, 5, ROOT_HINT)

      await expect(send()).rejects.toThrow(/rejected by logic/)
    })

    test('refuses to rekey the verifier', async () => {
      const { send } = await verifyInLsig(hex(ROOT_DNSKEY.signature), 5, ROOT_HINT, {
        rekeyTo: localnet.context.testAccount.addr.toString(),
      })

      await expect(send()).rejects.toThrow(/rejected by logic/)
    })

    test.each<[string, Parameters<typeof verifyInLsig>[3]]>([
      ['send an amount', { amount: 1 }],
      ['pay a fee', { fee: 1000 }],
      ['close out', { closeRemainderTo: generateAccount().addr.toString() }],
      ['sign anything but a payment', { asAssetOptIn: true }],
    ])('refuses to let the verifier %s', async (_, tamper) => {
      const { send } = await verifyInLsig(hex(ROOT_DNSKEY.signature), 5, ROOT_HINT, tamper)

      await expect(send()).rejects.toThrow(/rejected by logic/)
    })

    test('refuses a note that does not name the key and digest it checked', async () => {
      const { send } = await verifyInLsig(hex(ROOT_DNSKEY.signature), 5, ROOT_HINT, { note: new Uint8Array(64) })

      await expect(send()).rejects.toThrow(/rejected by logic/)
    })

    test('runs out of budget in too small a group', async () => {
      const { send } = await verifyInLsig(hex(ROOT_DNSKEY.signature), 6)

      await expect(send()).rejects.toThrow(/budget/)
    })
  })
})

describe('RSA-4096 split over several groups', () => {
  const localnet = algorandFixture()
  beforeEach(localnet.newScope)

  /** A group can hold 16 transactions, and pool 16 inner transaction slots for each app call among them. */
  const GROUP_SIZE = 16
  const MAX_INNER = 256

  const deploySplitConsumer = async () => {
    const { algorand, testAccount } = localnet.context
    const factory = algorand.client.getTypedAppFactory(RsaSplitConsumerFactory, { defaultSender: testAccount.addr })
    const { appClient } = await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' })
    // The app account's own minimum balance.
    await algorand.send.payment({ sender: testAccount.addr, receiver: appClient.appAddress, amount: AlgoAmount.Algo(0.1) })
    return appClient
  }

  /** Deposit MBR credits for the sender: enough for the state box, and the credit box itself. */
  const deposit = async (consumer: Consumer, amount = AlgoAmount.Algo(1)) => {
    const { algorand, testAccount } = localnet.context
    const txn = await algorand.createTransaction.payment({ sender: testAccount.addr, receiver: consumer.appAddress, amount })
    await consumer.send.depositCredits({ args: { creditor: testAccount.addr.toString(), txn }, populateAppCallResources: true })
  }

  const credits = async (consumer: Consumer) =>
    (await consumer.state.box.userCredits.getMap()).get(localnet.context.testAccount.addr.toString())

  type Consumer = Awaited<ReturnType<typeof deploySplitConsumer>>
  type Group = RsaSplitConsumerComposer<unknown[]>

  /**
   * Send `calls` padded out to a full group with `pool` calls. The first call
   * raises the pooled budget, and its fee covers every inner OpUp it may need.
   */
  const sendGroup = (consumer: Consumer, calls: (group: Group, first: { staticFee: AlgoAmount }) => Group, count: number) => {
    let group = calls(consumer.newGroup() as Group, { staticFee: AlgoAmount.MicroAlgo(1000 * (GROUP_SIZE + MAX_INNER)) })
    for (let i = count; i < GROUP_SIZE; i++) {
      group = group.pool({ args: [], note: `pool ${i}`, staticFee: AlgoAmount.MicroAlgo(0) })
    }
    return group.send({ populateAppCallResources: true })
  }

  /** Verify the .pl KSK signature in two groups of 8 exponent bits each. */
  const verifyPl = async (signature: Uint8Array) => {
    const consumer = await deploySplitConsumer()
    await deposit(consumer)
    const creditsBefore = await credits(consumer)
    const hint = montgomeryHint(hex(PL_DNSKEY.publicKey).subarray(4))

    const first = await sendGroup(
      consumer,
      (g, fee) =>
        g
          .start({ args: { signature, publicKey: hex(PL_DNSKEY.publicKey), hint, budget: 180_000 }, ...fee })
          .step({ args: { bits: 8, budget: 0 }, staticFee: AlgoAmount.MicroAlgo(0) }),
      2,
    )
    const second = await sendGroup(
      consumer,
      (g, fee) =>
        g.step({ args: { bits: 8, budget: 170_000 }, ...fee }).finish({
          args: { signedData: hex(PL_DNSKEY.signedData), publicKey: hex(PL_DNSKEY.publicKey) },
          staticFee: AlgoAmount.MicroAlgo(0),
        }),
      2,
    )
    return {
      bitsLeft: [first.returns[1], second.returns[0]],
      valid: second.returns[1],
      refunded: (await credits(consumer)) === creditsBefore,
    }
  }

  test('accepts the .pl KSK signature over the .pl DNSKEY RRset', async () => {
    const { bitsLeft, valid, refunded } = await verifyPl(hex(PL_DNSKEY.signature))

    expect(bitsLeft).toEqual([8n, 0n])
    expect(valid).toBe(true)
    expect(refunded).toBe(true)
  })

  test('rejects it with one byte of the signature flipped', async () => {
    const signature = hex(PL_DNSKEY.signature)
    signature[100] ^= 0x01

    const { valid } = await verifyPl(signature)

    expect(valid).toBe(false)
  })

  test('refuses to start without MBR credits for the state box', async () => {
    const consumer = await deploySplitConsumer()
    await deposit(consumer, AlgoAmount.MicroAlgo(100_000))
    const hint = montgomeryHint(hex(PL_DNSKEY.publicKey).subarray(4))

    await expect(
      sendGroup(
        consumer,
        (g, fee) =>
          g.start({ args: { signature: hex(PL_DNSKEY.signature), publicKey: hex(PL_DNSKEY.publicKey), hint, budget: 40_000 }, ...fee }),
        1,
      ),
    ).rejects.toThrow(/CRD/)
  })
})
