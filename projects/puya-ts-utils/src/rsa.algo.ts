import { assert, BigUint, biguint, bytes, Bytes, op, uint64 } from '@algorandfoundation/algorand-typescript'

/**
 * Bytes per limb. Byte math takes operands of up to 64 bytes, and every opcode
 * costs the same whatever the operand size, so the widest limb is the cheapest.
 */
const LIMB: uint64 = 64

/** The largest modulus accepted, in bytes: RSA-4096. */
const MAX_MODULUS: uint64 = 512

/** DER DigestInfo prefixes (RFC 8017 §9.2), which precede the digest in the signed block. */
export const SHA256_DIGEST_INFO = Bytes.fromHex('3031300d060960864801650304020105000420')
export const SHA512_DIGEST_INFO = Bytes.fromHex('3051300d060960864801650304020305000440')

/**
 * The fixed head of a verification state: bits left to process, the exponent,
 * the modulus length, and `-n⁻¹ mod 2^512`. The modulus, the signature, the
 * signature in Montgomery form, and the accumulator follow, one width each.
 */
const HEADER: uint64 = 88

/** More than any exponent up to 4 bytes has bits: enough to finish in one step. */
const ALL_BITS: uint64 = 32

/**
 * Split the public key field of an RSA DNSKEY record (RFC 3110 §2) into
 * `[exponent, modulus]`.
 *
 * The field opens with the exponent length: one byte, or, when that byte is 0,
 * the two bytes after it. The exponent follows, and the modulus is the rest.
 */
export function parseRsaDnskey(publicKey: bytes): [bytes, bytes] {
  let exponentLength = op.getByte(publicKey, 0)
  let offset: uint64 = 1
  if (exponentLength === 0) {
    exponentLength = op.extractUint16(publicKey, 1)
    offset = 3
  }
  assert(publicKey.length > offset + exponentLength, 'RSA key has no modulus')
  return [op.extract(publicKey, offset, exponentLength), publicKey.slice(offset + exponentLength)]
}

/** Verify an RSASHA256 (DNSSEC algorithm 8) signature over a SHA-256 `digest`. See `rsaPkcs1v15Verify`. */
export function verifyRsaSha256(
  digest: bytes,
  signature: bytes,
  modulus: bytes,
  exponent: bytes,
  hint: bytes,
): boolean {
  assert(digest.length === 32, 'SHA-256 digest must be 32 bytes')
  return rsaPkcs1v15Verify(digest, signature, modulus, exponent, SHA256_DIGEST_INFO, hint)
}

/**
 * Verify an RSASHA512 (DNSSEC algorithm 10) signature over a SHA-512 `digest`.
 *
 * Hashing the signed data with `op.sha512` needs AVM 13 or later. This function
 * doesn't do any hashing itself, so it compiles at any AVM version. See `rsaPkcs1v15Verify`.
 */
export function verifyRsaSha512(
  digest: bytes,
  signature: bytes,
  modulus: bytes,
  exponent: bytes,
  hint: bytes,
): boolean {
  assert(digest.length === 64, 'SHA-512 digest must be 64 bytes')
  return rsaPkcs1v15Verify(digest, signature, modulus, exponent, SHA512_DIGEST_INFO, hint)
}

/**
 * Verify an RSASSA-PKCS1-v1_5 signature (RFC 8017 §8.2.2) over `digest`.
 *
 * The expected block `00 01 FF..FF 00 || digestInfo || digest` is built in full,
 * padded out to the modulus length, and compared byte-for-byte with
 * `signature ^ exponent mod modulus`. The decrypted block is never parsed,
 * because a lenient parser is what makes forgeries possible when e = 3.
 *
 * A well-formed signature that does not match returns `false`. Malformed input
 * asserts: see `rsaStart`, and a modulus too short to hold the block.
 *
 * Opcode cost scales with the modulus length and the exponent's bit length: an
 * RSA-2048 key with e = 65537 needs a pooled budget, and RSA-4096 needs more than
 * one group can pool. `rsaStart`, `rsaStep` and `rsaFinish` split the same check
 * into pieces for that. See the README.
 */
export function rsaPkcs1v15Verify(
  digest: bytes,
  signature: bytes,
  modulus: bytes,
  exponent: bytes,
  digestInfo: bytes,
  hint: bytes,
): boolean {
  // Checked up front too, so a bad digest fails before the expensive part.
  assert(modulus.length >= digestInfo.length + digest.length + 11, 'RSA modulus too short for the digest')
  return rsaFinish(rsaStep(rsaStart(signature, modulus, exponent, hint), ALL_BITS), digest, modulus, exponent, digestInfo)
}

/**
 * Begin a verification that runs in pieces, returning its state.
 *
 * Pass the state through `rsaStep` until it has no bits left, then to
 * `rsaFinish`. It is plain bytes, so it can be kept in a box between groups:
 * `24 + 64 + 4·width` bytes, where the width is the modulus length rounded up to
 * 64 bytes (2136 for RSA-4096). The steps trust it: anyone who can write it can
 * make any signature verify, so keep it where only your contract can write it,
 * and one per caller.
 *
 * Asserts on malformed input: a modulus over 512 bytes or even, a signature
 * whose length differs from the modulus or that is not below it, an exponent
 * over 4 bytes, even, or below 3, and a wrong Montgomery hint.
 *
 * `hint` is optional: the Montgomery constant `R² mod n`, left-padded to `k`
 * limbs, followed by the quotient `⌊R / n⌋`, where `R = 2^(512·k)` and `k` is
 * the modulus length in 64-byte limbs, rounded up. Pass empty bytes to have
 * `R² mod n` computed on chain instead, which costs ~50k for RSA-2048, and far
 * more for a modulus that does not fill its top limb (RSA-1280, say). A hint is
 * checked for about a tenth of that, and asserts if it is wrong.
 */
export function rsaStart(signature: bytes, modulus: bytes, exponent: bytes, hint: bytes): bytes {
  const length = modulus.length
  assert(length <= MAX_MODULUS, 'RSA modulus over 512 bytes')
  assert(length > 0 && op.getByte(modulus, 0) !== 0, 'RSA modulus has a leading zero')
  assert(signature.length === length, 'RSA signature length differs from the modulus')
  assert(exponent.length > 0 && exponent.length <= 4, 'RSA exponent must be 1 to 4 bytes')
  const e = op.btoi(exponent)
  assert(e >= 3 && e % 2 === 1, 'RSA exponent must be odd and at least 3')

  // Work in whole limbs: left-pad everything to a multiple of LIMB bytes.
  const width: uint64 = ((length + LIMB - 1) / LIMB) * LIMB
  const n = pad(modulus, width)
  const s = pad(signature, width)
  assert(op.getBit(n, width * 8 - 1), 'RSA modulus is even')
  assert(!gte(s, n), 'RSA signature is not below the modulus')

  const nInv = negInverse(limb(n, 0))
  const base = monMul(s, hint.length === 0 ? computeRSquared(n, nInv) : checkHint(hint, n, nInv), n, nInv)
  // Left-to-right square-and-multiply, starting past the exponent's top bit.
  return op
    .itob(op.bitLength(e) - 1)
    .concat(op.itob(e))
    .concat(op.itob(length))
    .concat(pad(Bytes(nInv), LIMB))
    .concat(n)
    .concat(s)
    .concat(base)
    .concat(base)
}

/**
 * Process up to `bits` more bits of the exponent: a Montgomery squaring each,
 * and a multiply for each set bit.
 *
 * The last bit, always set since `e` is odd, multiplies by plain `s` instead of
 * its Montgomery form. That cancels the `R`, so the result leaves Montgomery
 * form without a conversion.
 */
export function rsaStep(state: bytes, bits: uint64): bytes {
  let remaining = op.extractUint64(state, 0)
  const e = op.extractUint64(state, 8)
  const nInv = BigUint(op.extract(state, 24, LIMB))
  const width: uint64 = (state.length - HEADER) / 4
  const n = op.extract(state, HEADER, width)
  const s = op.extract(state, HEADER + width, width)
  const base = op.extract(state, HEADER + 2 * width, width)
  let acc = op.extract(state, HEADER + 3 * width, width)
  for (let done: uint64 = 0; done < bits && remaining > 0; done++) {
    remaining--
    acc = monMul(acc, acc, n, nInv)
    if (remaining === 0) {
      acc = monMul(acc, s, n, nInv)
    } else if (op.getBit(e, remaining)) {
      acc = monMul(acc, base, n, nInv)
    }
  }
  return op.replace(op.replace(state, 0, op.itob(remaining)), HEADER + 3 * width, acc)
}

/** How many exponent bits `state` has left for `rsaStep` to process. */
export function rsaBitsLeft(state: bytes): uint64 {
  return op.extractUint64(state, 0)
}

/**
 * Compare a finished state with the block expected for `digest`.
 *
 * Pass the key you trust, not one read from the state: a state started with
 * another key asserts, so a caller can't swap in a key of their own between
 * `rsaStart` and here. Asserts too if `rsaStep` has bits left, or if the
 * modulus is too short to hold the block.
 */
export function rsaFinish(state: bytes, digest: bytes, modulus: bytes, exponent: bytes, digestInfo: bytes): boolean {
  assert(op.extractUint64(state, 0) === 0, 'RSA verification is not finished')
  const length = op.extractUint64(state, 16)
  const width: uint64 = (state.length - HEADER) / 4
  assert(
    modulus.length === length &&
      op.extract(state, HEADER, width) === pad(modulus, width) &&
      exponent.length <= 8 &&
      op.btoi(exponent) === op.extractUint64(state, 8),
    'RSA state is for a different key',
  )
  const tail = digestInfo.concat(digest)
  assert(length >= tail.length + 11, 'RSA modulus too short for the digest')
  const block = Bytes.fromHex('0001')
    .concat(op.bzero<uint64>(length - 3 - tail.length).bitwiseInvert())
    .concat(Bytes.fromHex('00'))
    .concat(tail)
  return op.extract(state, HEADER + 3 * width, width) === pad(block, width)
}

/**
 * Check a prover's `R² mod n ‖ ⌊R / n⌋` and return the first part.
 *
 * `monMul(h, 1)` is `h·R⁻¹ mod n`, which is `R mod n` exactly when `h ≡ R²`.
 * It is below `n`, so `q·n + monMul(h, 1) = R` proves it is `R mod n`. `R/n`
 * is below `R / 2^(512·(k-1)) = 2^512`, so `q` is a single limb.
 */
function checkHint(hint: bytes, n: bytes, nInv: biguint): bytes {
  assert(hint.length > n.length && hint.length <= n.length + LIMB, 'Montgomery hint is the wrong length')
  const h = op.extract(hint, 0, n.length)
  const q = BigUint(op.extract(hint, n.length))
  assert(!gte(h, n), 'Montgomery hint is not below the modulus')
  const one = op.setBit(op.bzero(n.length), n.length * 8 - 1, 1)
  const rModN = monMul(h, one, n, nInv)
  // q·n + R mod n, limb by limb: every limb must come out zero, carrying exactly 1 out.
  let carry = BigUint(0)
  for (let i = n.length; i > 0; ) {
    i -= LIMB
    const r = mac(BigUint(op.extract(rModN, i, LIMB)), q, BigUint(op.extract(n, i, LIMB)), carry)
    assert(lo(r) === BigUint(0), 'Montgomery hint is wrong')
    carry = hi(r)
  }
  assert(carry === BigUint(1), 'Montgomery hint is wrong')
  return h
}

/**
 * `R² mod n`, where `R = 2^(8·n.length)`: what takes a number into Montgomery form.
 *
 * Starting from the largest power of two below `n`, modular doubling reaches
 * `2^(8·len + len/16) mod n`, which is `2^(len/16)` in Montgomery form. Seven
 * Montgomery squarings then raise that to `2^(8·len)` in Montgomery form, which
 * is `R·R mod n`.
 *
 * ponytail: a modulus whose bit length is not a multiple of 512 (say RSA-1280)
 * pays one extra doubling per missing bit. Pass a hint where it matters.
 */
function computeRSquared(n: bytes, nInv: biguint): bytes {
  const bits = op.bitLength(n)
  let x = op.setBit(op.bzero(n.length), n.length * 8 - bits, 1)
  for (let i = bits; i <= n.length * 8 + n.length / 16; i++) {
    const [carry, twice] = add(x, x)
    x = carry > BigUint(0) || gte(twice, n) ? sub(twice, n) : twice
  }
  for (let i: uint64 = 0; i < 7; i++) {
    x = monMul(x, x, n, nInv)
  }
  return x
}

/**
 * Montgomery product `a·b·R⁻¹ mod n` (CIOS, with the two inner loops merged).
 * `a` and `b` must be below `n`, and so is the result.
 */
function monMul(a: bytes, b: bytes, n: bytes, nInv: biguint): bytes {
  const len = n.length
  const bottom: uint64 = len - LIMB
  let t = op.bzero(len)
  let top = BigUint(0)
  // Limbs of b, from the least significant.
  for (let i = len; i > 0; ) {
    i -= LIMB
    const bi = BigUint(op.extract(b, i, LIMB))
    let r = mac(BigUint(op.extract(t, bottom, LIMB)), BigUint(op.extract(a, bottom, LIMB)), bi, BigUint(0))
    let c1 = hi(r)
    const s = lo(r)
    const m = low(s * nInv)
    // The low limb of s + m·n₀ is zero by construction of m: only the carry matters.
    let c2 = hi(mac(s, m, BigUint(op.extract(n, bottom, LIMB)), BigUint(0)))
    let next = Bytes()
    for (let j = bottom; j > 0; ) {
      j -= LIMB
      r = mac(BigUint(op.extract(t, j, LIMB)), BigUint(op.extract(a, j, LIMB)), bi, c1)
      c1 = hi(r)
      r = mac(lo(r), m, BigUint(op.extract(n, j, LIMB)), c2)
      c2 = hi(r)
      next = op.extract(r, 0, LIMB).concat(next)
    }
    r = mac(c1, top, BigUint(1), c2)
    t = op.extract(r, 0, LIMB).concat(next)
    top = hi(r)
  }
  return top > BigUint(0) || gte(t, n) ? sub(t, n) : t
}

/**
 * `t + x·y + c`, as its low limb (always 64 bytes) followed by its high limb.
 *
 * With every input below `W = 2^512` the sum is below `W²`, so the high limb is
 * below `W` too and can be fed straight back in as the next carry. The padding
 * is written out rather than called: this is the innermost loop.
 */
function mac(t: biguint, x: biguint, y: biguint, c: biguint): bytes {
  const p = pad128(x * y)
  let u = Bytes(BigUint(op.extract(p, LIMB, LIMB)) + t)
  u = op.bzero(LIMB + 1 - u.length).concat(u)
  let v = Bytes(BigUint(op.extract(u, 1, LIMB)) + c)
  v = op.bzero(LIMB + 1 - v.length).concat(v)
  return op
    .extract(v, 1, LIMB)
    .concat(Bytes(BigUint(op.extract(p, 0, LIMB)) + BigUint(op.getByte(u, 0) + op.getByte(v, 0))))
}

/** The low limb of a `mac` result. */
function lo(r: bytes): biguint {
  return BigUint(op.extract(r, 0, LIMB))
}

/** The high limb of a `mac` result. */
function hi(r: bytes): biguint {
  return BigUint(op.extract(r, LIMB))
}

/** `x mod 2^512`, for `x` of up to two limbs. */
function low(x: biguint): biguint {
  return BigUint(op.extract(pad128(x), LIMB, LIMB))
}

/** A product of two limbs, zero-padded to two limbs. */
function pad128(x: biguint): bytes {
  const b = Bytes(x)
  return op.bzero(2 * LIMB - b.length).concat(b)
}

/** `-n₀⁻¹ mod 2^512`, by Newton iteration: each step doubles the correct low bits, from 1. */
function negInverse(n0: biguint): biguint {
  let m = BigUint(1)
  for (let i: uint64 = 0; i < 9; i++) {
    m = low(m * low(low(n0 * m) + BigUint(2)))
  }
  return m
}

/** `x + y` over whole limbs, as `[carry out, sum]`. */
function add(x: bytes, y: bytes): [biguint, bytes] {
  let carry = BigUint(0)
  let sum = Bytes()
  for (let j: uint64 = 0; j < x.length / LIMB; j++) {
    const r = mac(limb(x, j), limb(y, j), BigUint(1), carry)
    carry = hi(r)
    sum = op.extract(r, 0, LIMB).concat(sum)
  }
  return [carry, sum]
}

/** `x - n` modulo the width, as `x` plus the two's complement of `n`. */
function sub(x: bytes, n: bytes): bytes {
  const [, difference] = add(x, negate(n))
  return difference
}

/** The two's complement of an odd `n` over its width: `~n + 1`, which for odd `n` is `~n | 1`. */
function negate(n: bytes): bytes {
  return n.bitwiseInvert().bitwiseOr(Bytes.fromHex('01'))
}

/** Whether `x >= y`, for numbers of the same whole-limb length. */
function gte(x: bytes, y: bytes): boolean {
  for (let offset: uint64 = 0; offset < x.length; offset += LIMB) {
    const xl = BigUint(op.extract(x, offset, LIMB))
    const yl = BigUint(op.extract(y, offset, LIMB))
    if (xl !== yl) {
      return xl > yl
    }
  }
  return true
}

/** Limb `i` of `x`, counting from the least significant. */
function limb(x: bytes, i: uint64): biguint {
  return BigUint(op.extract(x, x.length - (i + 1) * LIMB, LIMB))
}

/** `x` left-padded with zero bytes to `width`. */
function pad(x: bytes, width: uint64): bytes {
  return op.bzero(width - x.length).concat(x)
}
