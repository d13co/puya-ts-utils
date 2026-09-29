/*
 * Error codes for rsa.algo.ts. Each doc comment is the message: the SDK's error
 * generator reads it from here.
 *
 * These are plain `assert` messages, not `loggedAssert` codes, because the
 * subroutines also run in logic signatures, which cannot log. The `ERR:` prefix
 * is part of the value for the same reason. In an app, algokit reports the
 * message from the ARC-56 source info. In a logic signature, the SDK maps the
 * failing pc back to it.
 */

/** RSA key has no modulus */
export const errNoModulus = 'ERR:NOMOD'
/** Digest is the wrong length for its hash */
export const errDigestLength = 'ERR:DIGLEN'
/** RSA modulus too short for the digest */
export const errModulusShort = 'ERR:MODSHORT'
/** RSA modulus over 512 bytes */
export const errModulusLong = 'ERR:MODLONG'
/** RSA modulus is empty or has a leading zero */
export const errModulusZero = 'ERR:MODZERO'
/** RSA modulus is even */
export const errModulusEven = 'ERR:MODEVEN'
/** RSA signature length differs from the modulus */
export const errSignatureLength = 'ERR:SIGLEN'
/** RSA signature is not below the modulus */
export const errSignatureRange = 'ERR:SIGRANGE'
/** RSA exponent must be 1 to 4 bytes */
export const errExponentLength = 'ERR:EXPLEN'
/** RSA exponent must be odd and at least 3 */
export const errExponent = 'ERR:EXPVAL'
/** RSA verification is not finished */
export const errUnfinished = 'ERR:UNFINISHED'
/** RSA state is for a different key */
export const errKeyMismatch = 'ERR:KEY'
/** Montgomery hint is the wrong length */
export const errHintLength = 'ERR:HINTLEN'
/** Montgomery hint is not below the modulus */
export const errHintRange = 'ERR:HINTRANGE'
/** Montgomery hint is wrong */
export const errHint = 'ERR:BADHINT'
