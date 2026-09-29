import { Account, Bytes, bytes, op, uint64 } from '@algorandfoundation/algorand-typescript'

/**
 * The RFC 4648 base32 alphabet, indexed by the 5-bit group each character stands for.
 */
const ALPHABET = Bytes('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')

/**
 * Encode bytes as base32, in the unpadded RFC 4648 form Algorand uses everywhere.
 *
 * ```ts
 * const text = base32Encode(Bytes.fromHex('666f6f626172')) // 'MZXW6YTBOI'
 * ```
 *
 * Base32 rewrites the input five bits at a time, so every five bytes of input
 * become eight characters. An input that is not a multiple of five bytes leaves
 * a part-filled group at the end, which is padded out with zero bits; RFC 4648
 * then pads the encoding itself with `=` up to a multiple of eight characters.
 * Those `=` are omitted here, which is the convention Algorand follows for
 * addresses, transaction ids and block hashes.
 *
 * The result is a `string` only in the sense that the AVM has no separate
 * character type: it is the same byte sequence either way, and `Bytes(...)` will
 * take it back the other way if you need to concatenate it with binary data.
 *
 * ## Cost
 *
 * About **94 opcodes per five bytes** of input, measured on LocalNet: a shift,
 * a mask, a table lookup and a concatenation for each character, over a loop
 * that runs once per group. An application call starts with a budget of 700;
 * an ABI method that takes the bytes and returns the encoding spends about 88
 * of it on its own, which leaves room for 30 bytes. A 36-byte input — a public key and its
 * checksum, which is what an address is made of — costs 840, so it needs the
 * budget raised first, either with `ensureBudget` inside the contract or with
 * another application call in the group.
 *
 * This subroutine will not raise the budget for you: that spends an inner
 * transaction and the fee for it, which is the caller's decision to make.
 *
 * The AVM caps a byte value at 4096 bytes, and the cap applies to the encoding
 * as much as to the input, so inputs above 2560 bytes cannot be encoded at all.
 * Returning the encoding from an ABI method logs it, and a log line is capped
 * at 1024 bytes, which stops a returned encoding at about 636 bytes of input.
 *
 * @param data The bytes to encode. May be empty, which encodes to an empty string.
 * @returns `data` in base32, without trailing `=` padding.
 */
export function base32Encode(data: bytes): string {
  const byteLength: uint64 = data.length

  // Zero-pad up to a whole number of five-byte groups, so the loop below can
  // treat every group alike. The padding characters are dropped at the end.
  const groups: uint64 = (byteLength + 4) / 5
  const padding: uint64 = groups * 5 - byteLength
  const padded = data.concat(op.bzero(padding))

  let encoded = Bytes()
  for (let group: uint64 = 0; group < groups; group += 1) {
    // Five bytes fit in the low 40 bits of a uint64, where they read as eight
    // 5-bit indices into the alphabet, most significant first.
    const bits: uint64 = op.btoi(op.extract(padded, group * 5, 5))

    encoded = encoded
      .concat(op.extract(ALPHABET, bits >> 35, 1))
      .concat(op.extract(ALPHABET, (bits >> 30) & 31, 1))
      .concat(op.extract(ALPHABET, (bits >> 25) & 31, 1))
      .concat(op.extract(ALPHABET, (bits >> 20) & 31, 1))
      .concat(op.extract(ALPHABET, (bits >> 15) & 31, 1))
      .concat(op.extract(ALPHABET, (bits >> 10) & 31, 1))
      .concat(op.extract(ALPHABET, (bits >> 5) & 31, 1))
      .concat(op.extract(ALPHABET, bits & 31, 1))
  }

  // Keep only the characters that carry input bits: ceil(byteLength * 8 / 5) of
  // them. The rest encode nothing but the zero padding added above.
  return encoded.slice(0, (byteLength * 8 + 4) / 5).toString()
}

/**
 * Write an account out as its 58-character Algorand address.
 *
 * An address is not the raw public key: it is the public key followed by the
 * last four bytes of its `sha512_256` digest, the pair encoded as base32.
 *
 * Encoding those 36 bytes costs about 840 opcodes, more than the 700 an
 * application call starts with, so raise the budget before calling this (for
 * example with `ensureBudget(1200, OpUpFeeSource.GroupCredit)`). As with
 * {@link base32Encode}, that is left to the caller.
 *
 * @param account The account to write out.
 * @returns The account's address, as wallets and explorers show it.
 */
export function encodeAddress(account: Account): string {
  const publicKey = account.bytes
  const checksum = op.extract(op.sha512_256(publicKey), 28, 4)

  return base32Encode(publicKey.concat(checksum))
}
