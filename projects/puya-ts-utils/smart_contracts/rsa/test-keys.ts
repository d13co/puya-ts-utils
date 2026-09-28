import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { rsaMontgomeryHint } from '../../src/rsaHint'

/** The Montgomery hint for `modulus`, as a Buffer. */
export const montgomeryHint = (modulus: Uint8Array): Buffer => Buffer.from(rsaMontgomeryHint(modulus))

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

/** `hash` of the bytes in `hex`. */
export const digestHex = (hash: 'sha256' | 'sha512', hex: string): Buffer => createHash(hash).update(Buffer.from(hex, 'hex')).digest()
