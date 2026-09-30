import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import { generateAccount, TransactionWithSigner } from 'algosdk'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, test } from 'vitest'
import { RsaConsumerFactory } from '../artifacts/rsa/RsaConsumerClient'
import { RsaSplitConsumerFactory, RsaSplitSDK, RsaVerifierSDK } from '../../src/rsaSdk'
import { sendMutated } from '../test-helpers'
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
    const publicKey = hex(ROOT_DNSKEY.publicKey)
    const digest = createHash('sha256').update(hex(ROOT_DNSKEY.signedData)).digest()

    const verifierSdk = () => {
      const { algorand, testAccount } = localnet.context
      return new RsaVerifierSDK({ algorand, writerAccount: { sender: testAccount.addr, signer: testAccount.signer } })
    }

    /** The verifier's group with the hint, 5 transactions, as the SDK builds it. */
    const verifierGroup = (sdk: RsaVerifierSDK, signature = hex(ROOT_DNSKEY.signature)) =>
      sdk['makeVerifyTxns']({ digest, signature, publicKey, hint: ROOT_HINT, groupSize: 5 })

    test('verifies the root KSK signature, pooling budget across 7 transactions', async () => {
      const sdk = verifierSdk()

      const result = await sdk.verify({ digest, signature: hex(ROOT_DNSKEY.signature), publicKey })

      console.log(`RsaSha256Verifier program: ${sdk.program.length} bytes`)
      expect(result.transactions).toHaveLength(7)
    })

    test('verifies it across 5 transactions given the Montgomery hint', async () => {
      const result = await verifierSdk().verify({ digest, signature: hex(ROOT_DNSKEY.signature), publicKey, hint: ROOT_HINT })

      expect(result.transactions).toHaveLength(5)
    })

    test('rejects the signature with one byte flipped', async () => {
      const signature = hex(ROOT_DNSKEY.signature)
      signature[100] ^= 0x01

      await expect(verifierSdk().verify({ digest, signature, publicKey, hint: ROOT_HINT })).rejects.toThrow(
        'Error BADSIG: RSA signature does not verify',
      )
    })

    test('maps a failure inside the RSA subroutines to its code', async () => {
      const wrongHint = Buffer.from(ROOT_HINT)
      wrongHint[100] ^= 0x01

      await expect(
        verifierSdk().verify({ digest, signature: hex(ROOT_DNSKEY.signature), publicKey, hint: wrongHint, groupSize: 5 }),
      ).rejects.toThrow('Error BADHINT: Montgomery hint is wrong')
    })

    test('refuses a key with no modulus', async () => {
      await expect(
        verifierSdk().verify({ digest, signature: hex(ROOT_DNSKEY.signature), publicKey: hex('03010001'), groupSize: 2 }),
      ).rejects.toThrow('Error NOMOD: RSA key has no modulus')
    })

    test.each<[string, (txns: TransactionWithSigner[]) => void]>([
      // @ts-expect-error readonly
      ['rekey the verifier', ([v]) => (v.txn.rekeyTo = localnet.context.testAccount.addr)],
      // @ts-expect-error readonly
      ['let the verifier send an amount', ([v]) => (v.txn.payment!.amount = 1n)],
      ['let the verifier pay a fee', ([v]) => (v.txn.fee = 1000n)],
      // @ts-expect-error readonly
      ['let the verifier close out', ([v]) => (v.txn.payment!.closeRemainderTo = generateAccount().addr)],
    ])('refuses to %s', async (_, mutate) => {
      const sdk = verifierSdk()

      await expect(sendMutated(sdk, verifierGroup(sdk), mutate)).rejects.toThrow('Error INERT')
    })

    test('refuses to let the verifier sign anything but a payment', async () => {
      const sdk = verifierSdk()
      const { algorand, testAccount } = localnet.context
      const { assetId } = await algorand.send.assetCreate({ sender: testAccount, total: 1n })

      await expect(
        sendMutated(sdk, verifierGroup(sdk), async (txns) => {
          const [{ txn, signer }] = txns
          const optIn = await algorand.createTransaction.assetOptIn({ sender: txn.sender, assetId, staticFee: AlgoAmount.MicroAlgo(0), note: txn.note })
          txns[0] = { txn: optIn, signer }
        }),
      ).rejects.toThrow('Error INERT')
    })

    test('refuses a note that does not name the key and digest it checked', async () => {
      const sdk = verifierSdk()

      await expect(
        sendMutated(sdk, verifierGroup(sdk), ([v]) => {
          // @ts-expect-error readonly
          v.txn.note = new Uint8Array(64)
        }),
      ).rejects.toThrow('Error NOTE: Verifier note must be sha256(key) ‖ digest')
    })

    test('runs out of budget in too small a group', async () => {
      await expect(verifierSdk().verify({ digest, signature: hex(ROOT_DNSKEY.signature), publicKey, groupSize: 6 })).rejects.toThrow(
        /budget/,
      )
    })
  })
})

describe('RSA-4096 split over several groups', () => {
  const localnet = algorandFixture()
  beforeEach(localnet.newScope)

  const plKey = hex(PL_DNSKEY.publicKey)
  const plHint = montgomeryHint(plKey.subarray(4))

  const deploySdk = async () => {
    const { algorand, testAccount } = localnet.context
    const factory = algorand.client.getTypedAppFactory(RsaSplitConsumerFactory, { defaultSender: testAccount.addr })
    const { appClient } = await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' })
    // The app account's own minimum balance.
    await algorand.send.payment({ sender: testAccount.addr, receiver: appClient.appAddress, amount: AlgoAmount.Algo(0.1) })
    return new RsaSplitSDK({ algorand, appId: appClient.appId, writerAccount: { sender: testAccount.addr, signer: testAccount.signer } })
  }

  const credits = async (sdk: RsaSplitSDK) => (await sdk.credits([localnet.context.testAccount.addr]))[0]

  /** Verify the .pl KSK signature in two groups of 8 exponent bits each. */
  const verifyPl = async (signature: Uint8Array) => {
    const sdk = await deploySdk()
    await sdk.depositCredits({ amount: AlgoAmount.Algo(1) })
    const creditsBefore = await credits(sdk)

    const first = await sdk.run([
      { start: { signature, publicKey: plKey, hint: plHint, budget: 180_000 } },
      { step: { bits: 8, budget: 0 } },
    ])
    const second = await sdk.run([
      { step: { bits: 8, budget: 170_000 } },
      { finish: { signedData: hex(PL_DNSKEY.signedData), publicKey: plKey } },
    ])
    return {
      bitsLeft: [first[1], second[0]],
      valid: second[1],
      refunded: (await credits(sdk)) === creditsBefore,
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
    const sdk = await deploySdk()
    await sdk.depositCredits({ amount: AlgoAmount.MicroAlgo(100_000) })

    await expect(
      sdk.run([{ start: { signature: hex(PL_DNSKEY.signature), publicKey: plKey, hint: plHint, budget: 40_000 } }]),
    ).rejects.toThrow('Error crd: Insufficient credits')
  })

  test('refuses to finish with exponent bits left', async () => {
    const sdk = await deploySdk()
    await sdk.depositCredits({ amount: AlgoAmount.Algo(1) })

    await expect(
      sdk.run([
        { start: { signature: hex(PL_DNSKEY.signature), publicKey: plKey, hint: plHint, budget: 40_000 } },
        { finish: { signedData: hex(PL_DNSKEY.signedData), publicKey: plKey } },
      ]),
    ).rejects.toThrow('Error UNFINISHED: RSA verification is not finished')
  })

  test('maps app errors to their code with a verifier SDK on the same client, built first', async () => {
    const { algorand, testAccount } = localnet.context
    new RsaVerifierSDK({ algorand, writerAccount: { sender: testAccount.addr, signer: testAccount.signer } })
    const sdk = await deploySdk()
    await sdk.depositCredits({ amount: AlgoAmount.Algo(1) })

    // A plain assert's code, which only the app client's own transformer puts in the message.
    await expect(
      sdk.run([
        { start: { signature: hex(PL_DNSKEY.signature), publicKey: plKey, hint: plHint, budget: 40_000 } },
        { finish: { signedData: hex(PL_DNSKEY.signedData), publicKey: plKey } },
      ]),
    ).rejects.toThrow('Error UNFINISHED: RSA verification is not finished')
  })

  const withdraw = (sdk: RsaSplitSDK) => sdk.writeClient.send.withdrawCredits({
    args: [], extraFee: AlgoAmount.MicroAlgo(1000), populateAppCallResources: true,
  })

  test.each([true, false])('keeps the refund destination until a finished verification returns %s', async (valid) => {
    const sdk = await deploySdk()
    await sdk.depositCredits({ amount: AlgoAmount.Algo(1) })
    const creditsBefore = await credits(sdk)
    const { modulus, exponent, signature } = signWithNewKey(1024, 65537, 'sha256')
    const publicKey = Buffer.concat([Buffer.from([exponent.length]), exponent, modulus])
    if (!valid) signature[7] ^= 1
    await sdk.run([
      { start: { signature, publicKey, hint: montgomeryHint(modulus), budget: 40_000 } },
      { step: { bits: 32, budget: 0 } },
    ])
    const lockedCredits = await credits(sdk)

    await expect(withdraw(sdk)).rejects.toThrow('Error PENDINGRSA')
    expect(await credits(sdk)).toBe(lockedCredits)
    expect(await sdk.run([{ finish: { signedData: Buffer.from('example.'), publicKey } }])).toEqual([valid])
    expect(await credits(sdk)).toBe(creditsBefore)

    const result = await withdraw(sdk)
    expect(result.confirmation.innerTxns![0].txn.txn.payment!.amount).toBe(1_000_000n)
  })

  test('cancels an unfinished RSA-4096 check and withdraws its full deposit without another payment', async () => {
    const sdk = await deploySdk()
    await sdk.depositCredits({ amount: AlgoAmount.Algo(1) })
    const creditsBefore = await credits(sdk)
    await sdk.run([{ start: { signature: hex(PL_DNSKEY.signature), publicKey: plKey, hint: plHint, budget: 40_000 } }])

    await expect(withdraw(sdk)).rejects.toThrow('Error PENDINGRSA')
    await sdk.cancel()
    expect(await credits(sdk)).toBe(creditsBefore)
    await sdk.cancel() // Already cancelled: no extra refund.
    expect(await credits(sdk)).toBe(creditsBefore)

    const result = await withdraw(sdk)
    expect(result.confirmation.innerTxns![0].txn.txn.payment!.amount).toBe(1_000_000n)
  })

  test('cancellation cannot remove another sender\'s verification', async () => {
    const sdk = await deploySdk()
    await sdk.depositCredits({ amount: AlgoAmount.Algo(1) })
    await sdk.run([{ start: { signature: hex(PL_DNSKEY.signature), publicKey: plKey, hint: plHint, budget: 40_000 } }])
    const creditsBefore = await credits(sdk)
    const other = await localnet.algorand.account.random()
    await localnet.algorand.account.ensureFundedFromEnvironment(other.addr, AlgoAmount.Algo(1))
    const otherSdk = new RsaSplitSDK({
      algorand: sdk.algorand, appId: sdk.appId, writerAccount: { sender: other.addr, signer: other.signer },
    })

    await otherSdk.cancel()
    expect(await credits(sdk)).toBe(creditsBefore)
    expect(await sdk.run([{ step: { bits: 1, budget: 25_000 } }])).toEqual([15n])
    await sdk.cancel()
  })

  test('reads the credits of more accounts than a transaction can name boxes for', async () => {
    const sdk = await deploySdk()
    await sdk.depositCredits({ amount: AlgoAmount.MicroAlgo(500_000) })
    const others = Array.from({ length: 9 }, () => generateAccount().addr)

    const [mine, ...theirs] = await sdk.credits([localnet.context.testAccount.addr, ...others])

    // Less the credit box's own MBR: 2,500 plus 400 per byte of its 33-byte name and 8-byte value.
    expect(mine).toBe(500_000n - 2_500n - 400n * (33n + 8n))
    expect(theirs).toEqual(Array(9).fill(undefined))
  })
})
