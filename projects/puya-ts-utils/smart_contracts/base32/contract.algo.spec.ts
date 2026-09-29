import { Bytes } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext, toExternalValue } from '@algorandfoundation/algorand-typescript-testing'
import { encodeAddress as sdkEncodeAddress } from 'algosdk'
import { afterEach, describe, expect, it } from 'vitest'
import { base32Encode, encodeAddress } from '../../src/base32.algo'
import { Base32Consumer } from './consumer.algo'
import { randomBytes, referenceEncode } from './reference'

const ctx = new TestExecutionContext()
afterEach(() => ctx.reset())

const bytesOf = (data: Uint8Array) => Bytes.fromHex(Buffer.from(data).toString('hex'))

describe('base32Encode', () => {
  /** RFC 4648 section 10, less the `=` padding this encoder leaves off. */
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('encodes %o as %o', (input, expected) => {
    expect(base32Encode(Bytes(input))).toEqual(expected)
  })

  it('encodes nothing as nothing', () => {
    expect(base32Encode(Bytes())).toEqual('')
  })

  it('never pads the output', () => {
    for (let length = 0; length <= 20; length += 1) {
      expect(base32Encode(bytesOf(randomBytes(length)))).not.toContain('=')
    }
  })

  it('spends eight characters on every five bytes, and no more than it has to', () => {
    // Written without a rounding division on purpose: this file is rewritten to
    // run against the AVM emulator, where `/` truncates like the machine does.
    const charactersFor = [0, 2, 4, 5, 7]

    for (let length = 0; length <= 40; length += 1) {
      const remainder = length % 5
      const expected = ((length - remainder) / 5) * 8 + charactersFor[remainder]

      expect(base32Encode(bytesOf(randomBytes(length))).length).toEqual(expected)
    }
  })

  it('draws only on the RFC 4648 alphabet', () => {
    const encoded = base32Encode(bytesOf(randomBytes(64)))

    expect(encoded).toMatch(/^[A-Z2-7]+$/)
  })

  it('agrees with a straightforward implementation at every length', () => {
    for (let length = 0; length <= 40; length += 1) {
      const data = randomBytes(length)

      expect(base32Encode(bytesOf(data))).toEqual(referenceEncode(data))
    }
  })

  it('carries bits across the group boundary', () => {
    // 0xFF spills its last three bits into the second character, and the
    // trailing zero bits of the padding fill that character out.
    expect(base32Encode(Bytes.fromHex('ff'))).toEqual('74')
    expect(base32Encode(Bytes.fromHex('ffffffffff'))).toEqual('77777777')
    expect(base32Encode(Bytes.fromHex('00'))).toEqual('AA')
    expect(base32Encode(Bytes.fromHex('0000000000'))).toEqual('AAAAAAAA')
  })

  it('handles an input that is an exact number of groups', () => {
    const data = randomBytes(50)

    expect(base32Encode(bytesOf(data))).toEqual(referenceEncode(data))
  })
})

describe('encodeAddress', () => {
  it('writes out the 58-character address, checksum included', () => {
    const account = ctx.any.account()

    expect(encodeAddress(account)).toEqual(sdkEncodeAddress(toExternalValue(account.bytes)))
  })
})

describe('the consumer contract', () => {
  const call = <T>(consumer: Base32Consumer, method: () => T) =>
    ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: consumer })]).execute(method)

  it('encodes bytes handed to it in an application call', () => {
    const consumer = ctx.contract.create(Base32Consumer)
    const data = randomBytes(37)

    expect(call(consumer, () => consumer.encode(bytesOf(data)))).toEqual(referenceEncode(data))
  })

  it('writes an account out the way the rest of Algorand does', () => {
    const consumer = ctx.contract.create(Base32Consumer)
    const account = ctx.any.account()

    const encoded = call(consumer, () => consumer.encodeAddress(account))

    expect(encoded).toEqual(sdkEncodeAddress(toExternalValue(account.bytes)))
    expect(encoded.length).toEqual(58)
  })
})
