import { Bytes } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { afterEach, describe, expect, it } from 'vitest'
import { RsaConsumer, RsaSplitConsumer } from './consumer.algo'
import { PL_DNSKEY, ROOT_DNSKEY } from './dnskey-fixtures'
import { montgomeryHint, signWithNewKey } from './test-keys'

const ctx = new TestExecutionContext()
afterEach(() => ctx.reset())

const hex = (h: string) => Bytes.fromHex(h)
const b = (buf: Buffer) => Bytes(new Uint8Array(buf))

/** Leave R² to be computed on chain. */
const NO_HINT = Bytes()

const SHA256_DIGEST_INFO = Bytes.fromHex('3031300d060960864801650304020105000420')

/** An RFC 3110 DNSKEY public key field: exponent length, exponent, modulus. */
const dnskey = (exponent: Buffer, modulus: Buffer) => b(Buffer.concat([Buffer.from([exponent.length]), exponent, modulus]))

/** A copy of `buf` with one bit of byte `i` flipped. */
const flip = (buf: Buffer, i: number) => {
  const copy = Buffer.from(buf)
  copy[i] ^= 0x01
  return copy
}

describe('RRSIG verification', () => {
  it('accepts the root KSK signature over the root DNSKEY RRset', () => {
    const consumer = ctx.contract.create(RsaConsumer)

    expect(consumer.verifyRrsig(hex(ROOT_DNSKEY.signedData), hex(ROOT_DNSKEY.signature), hex(ROOT_DNSKEY.publicKey), NO_HINT)).toBe(true)
  })

  it('rejects it with one byte of the signature flipped', () => {
    const consumer = ctx.contract.create(RsaConsumer)
    const signature = flip(Buffer.from(ROOT_DNSKEY.signature, 'hex'), 100)

    expect(consumer.verifyRrsig(hex(ROOT_DNSKEY.signedData), b(signature), hex(ROOT_DNSKEY.publicKey), NO_HINT)).toBe(false)
  })

  it('rejects it over different data', () => {
    const consumer = ctx.contract.create(RsaConsumer)
    const signedData = flip(Buffer.from(ROOT_DNSKEY.signedData, 'hex'), 0)

    expect(consumer.verifyRrsig(b(signedData), hex(ROOT_DNSKEY.signature), hex(ROOT_DNSKEY.publicKey), NO_HINT)).toBe(false)
  })
})

describe('key sizes and exponents', () => {
  it.each([
    [1024, 65537],
    [2048, 65537],
    [4096, 65537],
    [1280, 65537],
    [2048, 3],
  ])('verifies RSA-%i with e = %i, and rejects a flipped byte', (bits, e) => {
    const consumer = ctx.contract.create(RsaConsumer)
    const { modulus, exponent, digest, signature } = signWithNewKey(bits, e, 'sha256')

    expect(consumer.verifySha256(b(digest), b(signature), b(modulus), b(exponent), NO_HINT)).toBe(true)
    expect(consumer.verifySha256(b(digest), b(flip(signature, 7)), b(modulus), b(exponent), NO_HINT)).toBe(false)
  })

  it('verifies RSASHA512', () => {
    const consumer = ctx.contract.create(RsaConsumer)
    const { modulus, exponent, digest, signature } = signWithNewKey(2048, 65537, 'sha512')

    expect(consumer.verifySha512(b(digest), b(signature), b(modulus), b(exponent), NO_HINT)).toBe(true)
    expect(consumer.verifySha512(b(flip(digest, 0)), b(signature), b(modulus), b(exponent), NO_HINT)).toBe(false)
  })

  it('does not accept a SHA-512 signature as SHA-256 over the same message', () => {
    const consumer = ctx.contract.create(RsaConsumer)
    const { modulus, exponent, signature } = signWithNewKey(2048, 65537, 'sha512')
    const sha256 = signWithNewKey(1024, 65537, 'sha256').digest

    expect(consumer.verifySha256(b(sha256), b(signature), b(modulus), b(exponent), NO_HINT)).toBe(false)
  })
})

describe('the Montgomery hint', () => {
  it.each([1024, 1280, 2047, 2048, 3072])('verifies RSA-%i with it, and rejects a flipped byte', (bits) => {
    const consumer = ctx.contract.create(RsaConsumer)
    const { modulus, exponent, digest, signature } = signWithNewKey(bits, 65537, 'sha256')
    const hint = b(montgomeryHint(modulus))

    expect(consumer.verifySha256(b(digest), b(signature), b(modulus), b(exponent), hint)).toBe(true)
    expect(consumer.verifySha256(b(digest), b(flip(signature, 7)), b(modulus), b(exponent), hint)).toBe(false)
  })

  it.each([
    ['R² mod n', 100],
    ['quotient', -1],
  ])('refuses a hint with a wrong %s', (_, at) => {
    const consumer = ctx.contract.create(RsaConsumer)
    const { modulus, exponent, digest, signature } = signWithNewKey(1280, 65537, 'sha256')
    const hint = montgomeryHint(modulus)

    expect(() =>
      consumer.verifySha256(b(digest), b(signature), b(modulus), b(exponent), b(flip(hint, (at + hint.length) % hint.length))),
    ).toThrow('Montgomery hint is wrong')
  })

  it('refuses a hint whose R² is not below the modulus', () => {
    const consumer = ctx.contract.create(RsaConsumer)
    const { modulus, exponent, digest, signature } = signWithNewKey(1024, 65537, 'sha256')
    const hint = Buffer.concat([modulus, Buffer.from([1])])

    expect(() => consumer.verifySha256(b(digest), b(signature), b(modulus), b(exponent), b(hint))).toThrow(
      'not below the modulus',
    )
  })

  // R mod n + n also satisfies q'·n + m' = R, with q' = q - 1. It is ruled out only
  // because monMul fully reduces its result, so both forgeries must fail.
  describe('forged off by one modulus', () => {
    // 2047 bits: n < R/2, so h + n still fits the width.
    const { modulus, exponent, digest, signature } = signWithNewKey(2047, 65537, 'sha256')
    const width = modulus.length + (64 - (modulus.length % 64)) % 64
    const hint = montgomeryHint(modulus)
    const n = BigInt('0x' + modulus.toString('hex'))
    const h = BigInt('0x' + hint.subarray(0, width).toString('hex'))
    const q = BigInt('0x' + hint.subarray(width).toString('hex'))
    const toBytes = (x: bigint, length: number) => Buffer.from(x.toString(16).padStart(2 * length, '0'), 'hex')

    it('refuses R² mod n + n', () => {
      const consumer = ctx.contract.create(RsaConsumer)
      const forged = Buffer.concat([toBytes(h + n, width), hint.subarray(width)])

      expect(() => consumer.verifySha256(b(digest), b(signature), b(modulus), b(exponent), b(forged))).toThrow(
        'not below the modulus',
      )
    })

    it('refuses the quotient one short, as if R mod n were R mod n + n', () => {
      const consumer = ctx.contract.create(RsaConsumer)
      const forged = Buffer.concat([hint.subarray(0, width), toBytes(q - 1n, 1)])

      expect(() => consumer.verifySha256(b(digest), b(signature), b(modulus), b(exponent), b(forged))).toThrow(
        'Montgomery hint is wrong',
      )
    })
  })

  it('refuses a hint with no quotient', () => {
    const consumer = ctx.contract.create(RsaConsumer)
    const { modulus, exponent, digest, signature } = signWithNewKey(1024, 65537, 'sha256')
    const hint = montgomeryHint(modulus).subarray(0, 128)

    expect(() => consumer.verifySha256(b(digest), b(signature), b(modulus), b(exponent), b(hint))).toThrow('wrong length')
  })
})

describe('parseRsaDnskey', () => {
  it('reads a one-byte exponent length', () => {
    const consumer = ctx.contract.create(RsaConsumer)

    const [exponent, modulus] = consumer.parse(hex('03010001aabbcc'))

    expect(exponent).toEqual(hex('010001'))
    expect(modulus).toEqual(hex('aabbcc'))
  })

  it('reads a three-byte exponent length when the first byte is zero', () => {
    const consumer = ctx.contract.create(RsaConsumer)

    const [exponent, modulus] = consumer.parse(hex('000003010001aabbcc'))

    expect(exponent).toEqual(hex('010001'))
    expect(modulus).toEqual(hex('aabbcc'))
  })

  it('refuses a key with no modulus', () => {
    const consumer = ctx.contract.create(RsaConsumer)

    expect(() => consumer.parse(hex('03010001'))).toThrow('RSA key has no modulus')
  })
})

describe('malformed input', () => {
  const { modulus, exponent, digest, signature } = signWithNewKey(1024, 65537, 'sha256')

  it('refuses a signature that is not below the modulus', () => {
    const consumer = ctx.contract.create(RsaConsumer)

    expect(() => consumer.verifySha256(b(digest), b(modulus), b(modulus), b(exponent), NO_HINT)).toThrow('not below the modulus')
  })

  it('refuses a signature of the wrong length', () => {
    const consumer = ctx.contract.create(RsaConsumer)

    expect(() => consumer.verifySha256(b(digest), b(signature.subarray(1)), b(modulus), b(exponent), NO_HINT)).toThrow(
      'length differs',
    )
  })

  it.each([
    ['over 4 bytes', '0100000001'],
    ['even', '010000'],
    ['below 3', '01'],
  ])('refuses an exponent %s', (_, e) => {
    const consumer = ctx.contract.create(RsaConsumer)

    expect(() => consumer.verifySha256(b(digest), b(signature), b(modulus), hex(e), NO_HINT)).toThrow('RSA exponent')
  })

  it('refuses a modulus with a leading zero', () => {
    const consumer = ctx.contract.create(RsaConsumer)
    const zero = Buffer.from([0])

    expect(() =>
      consumer.verifySha256(b(digest), b(Buffer.concat([zero, signature])), b(Buffer.concat([zero, modulus])), b(exponent), NO_HINT),
    ).toThrow('leading zero')
  })

  it('refuses an even modulus', () => {
    const consumer = ctx.contract.create(RsaConsumer)

    expect(() => consumer.verifySha256(b(digest), b(signature), b(flip(modulus, modulus.length - 1)), b(exponent), NO_HINT)).toThrow(
      'RSA modulus is even',
    )
  })

  it('refuses a digest of the wrong length', () => {
    const consumer = ctx.contract.create(RsaConsumer)

    expect(() => consumer.verifySha256(b(digest.subarray(1)), b(signature), b(modulus), b(exponent), NO_HINT)).toThrow('32 bytes')
  })

  it('refuses a modulus too short for the digest', () => {
    const consumer = ctx.contract.create(RsaConsumer)

    expect(() =>
      consumer.verify(b(digest), b(signature.subarray(0, 60)), b(modulus.subarray(0, 60)), b(exponent), SHA256_DIGEST_INFO, NO_HINT),
    ).toThrow('too short')
  })
})

describe('verification split over several calls', () => {
  /** The .pl KSK's modulus: its public key field after `03 010001`. */
  const plHint = b(montgomeryHint(Buffer.from(PL_DNSKEY.publicKey, 'hex').subarray(4)))

  const run = (consumer: RsaSplitConsumer, signature: string, chunks: number[]) => {
    consumer.start(hex(signature), hex(PL_DNSKEY.publicKey), plHint, 0)
    return chunks.map((bits) => consumer.step(bits, 0))
  }

  it.each([[[16]], [[5, 5, 6]], [[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]]])(
    'accepts the .pl RSA-4096 KSK signature, stepped in chunks of %j',
    (chunks) => {
      const consumer = ctx.contract.create(RsaSplitConsumer)

      const left = run(consumer, PL_DNSKEY.signature, chunks)

      expect(left[left.length - 1]).toEqual(0)
      expect(consumer.finish(hex(PL_DNSKEY.signedData), hex(PL_DNSKEY.publicKey))).toBe(true)
    },
  )

  it('rejects it with one byte of the signature flipped', () => {
    const consumer = ctx.contract.create(RsaSplitConsumer)
    const signature = flip(Buffer.from(PL_DNSKEY.signature, 'hex'), 100).toString('hex')

    run(consumer, signature, [16])

    expect(consumer.finish(hex(PL_DNSKEY.signedData), hex(PL_DNSKEY.publicKey))).toBe(false)
  })

  it('counts the exponent bits down, and stops at zero', () => {
    const consumer = ctx.contract.create(RsaSplitConsumer)

    expect(run(consumer, PL_DNSKEY.signature, [10, 10])).toEqual([6, 0])
  })

  it('refuses to finish with bits left', () => {
    const consumer = ctx.contract.create(RsaSplitConsumer)

    run(consumer, PL_DNSKEY.signature, [15])

    expect(() => consumer.finish(hex(PL_DNSKEY.signedData), hex(PL_DNSKEY.publicKey))).toThrow('not finished')
  })

  /** A key of the caller's own that really did sign the .pl RRset, started and run to the end. */
  const startOwn = (consumer: RsaSplitConsumer, e = 65537) => {
    const own = signWithNewKey(1024, e, 'sha256', Buffer.from(PL_DNSKEY.signedData, 'hex'))
    consumer.start(b(own.signature), dnskey(own.exponent, own.modulus), b(montgomeryHint(own.modulus)), 0)
    return { own, left: consumer.step(32, 0) }
  }

  it('refuses to finish against a key other than the one it started with', () => {
    const consumer = ctx.contract.create(RsaSplitConsumer)

    startOwn(consumer)

    expect(() => consumer.finish(hex(PL_DNSKEY.signedData), hex(PL_DNSKEY.publicKey))).toThrow('different key')
  })

  it('refuses to finish against the same modulus with another exponent', () => {
    const consumer = ctx.contract.create(RsaSplitConsumer)

    const { own } = startOwn(consumer)

    expect(() => consumer.finish(hex(PL_DNSKEY.signedData), dnskey(Buffer.from([3]), own.modulus))).toThrow('different key')
  })

  it('runs a 4-byte exponent to the end', () => {
    const consumer = ctx.contract.create(RsaSplitConsumer)

    const { own, left } = startOwn(consumer, 0x80000001)

    expect(left).toEqual(0)
    expect(consumer.finish(hex(PL_DNSKEY.signedData), dnskey(own.exponent, own.modulus))).toBe(true)
  })

  it('starts over when started again', () => {
    const consumer = ctx.contract.create(RsaSplitConsumer)
    run(consumer, flip(Buffer.from(PL_DNSKEY.signature, 'hex'), 100).toString('hex'), [4])

    run(consumer, PL_DNSKEY.signature, [16])

    expect(consumer.finish(hex(PL_DNSKEY.signedData), hex(PL_DNSKEY.publicKey))).toBe(true)
  })

  it('refuses to finish what was never started', () => {
    const consumer = ctx.contract.create(RsaSplitConsumer)

    expect(() => consumer.finish(hex(PL_DNSKEY.signedData), hex(PL_DNSKEY.publicKey))).toThrow()
  })

  it('keeps each sender to its own verification', () => {
    const consumer = ctx.contract.create(RsaSplitConsumer)
    const victim = ctx.defaultSender
    run(consumer, PL_DNSKEY.signature, [8])

    ctx.defaultSender = ctx.any.account()
    run(consumer, flip(Buffer.from(PL_DNSKEY.signature, 'hex'), 100).toString('hex'), [16])
    expect(consumer.finish(hex(PL_DNSKEY.signedData), hex(PL_DNSKEY.publicKey))).toBe(false)

    ctx.defaultSender = victim
    expect(consumer.step(8, 0)).toEqual(0)
    expect(consumer.finish(hex(PL_DNSKEY.signedData), hex(PL_DNSKEY.publicKey))).toBe(true)
  })
})
