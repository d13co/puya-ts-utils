/**
 * A plain, obviously-correct base32 for the suites to check the contract
 * against, plus the odds and ends they both need to drive it.
 *
 * This is ordinary TypeScript — it is never compiled to TEAL, and it is written
 * for clarity rather than for the AVM.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Encode bytes as unpadded base32 (RFC 4648) by consuming the input a byte at a
 * time, spilling a character out of the bit buffer whenever five bits have
 * gathered, and flushing whatever is left over at the end.
 */
export const referenceEncode = (data: Uint8Array): string => {
  let buffer = 0
  let bits = 0
  let encoded = ''

  for (const byte of data) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      encoded += ALPHABET[(buffer >> bits) & 31]
    }
  }
  if (bits > 0) encoded += ALPHABET[(buffer << (5 - bits)) & 31]

  return encoded
}

/** `length` bytes of noise to encode. */
export const randomBytes = (length: number) => Uint8Array.from({ length }, () => Math.floor(Math.random() * 256))
