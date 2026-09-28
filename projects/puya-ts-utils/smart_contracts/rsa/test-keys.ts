import { createHash, generateKeyPairSync, sign } from 'node:crypto'

/**
 * The Montgomery hint for `modulus`: `R² mod n` left-padded to `k` limbs, then
 * `⌊R / n⌋`, with `R = 2^(512·k)` and `k` the modulus length in 64-byte limbs,
 * rounded up.
 */
export const montgomeryHint = (modulus: Uint8Array): Buffer => {
  const width = Math.ceil(modulus.length / 64) * 64
  const n = BigInt('0x' + Buffer.from(modulus).toString('hex'))
  const r = 1n << BigInt(8 * width)
  const q = (r / n).toString(16)
  return Buffer.concat([
    Buffer.from(((r * r) % n).toString(16).padStart(2 * width, '0'), 'hex'),
    Buffer.from(q.padStart(q.length + (q.length % 2), '0'), 'hex'),
  ])
}

export type Signed = { modulus: Buffer; exponent: Buffer; digest: Buffer; signature: Buffer }

/**
 * A fresh RSA key and a PKCS#1 v1.5 signature over `message` made with it.
 *
 * This lives outside the spec file because node's crypto functions are
 * overloaded, and the Puya test transformer rejects any function type with more
 * than one call signature.
 */
export const signWithNewKey = (
  bits: number,
  publicExponent: number,
  hash: 'sha256' | 'sha512',
  message = Buffer.from('example.'),
): Signed => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: bits, publicExponent })
  const jwk = publicKey.export({ format: 'jwk' })
  return {
    modulus: Buffer.from(jwk.n!, 'base64url'),
    exponent: Buffer.from(jwk.e!, 'base64url'),
    digest: createHash(hash).update(message).digest(),
    signature: sign(hash, message, privateKey),
  }
}
