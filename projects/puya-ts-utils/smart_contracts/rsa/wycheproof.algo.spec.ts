import { Bytes } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { afterEach, describe, expect, it } from 'vitest'
import { RsaConsumer } from './consumer.algo'
import { digestHex, montgomeryHint } from './test-keys'
import vectors from './wycheproof.json'

const ctx = new TestExecutionContext()
afterEach(() => ctx.reset())

type Test = [tcId: number, result: 'valid' | 'invalid' | 'acceptable', comment: string, msg: string, sig: string]

/**
 * Wycheproof's RSASSA-PKCS1-v1_5 vectors: padding and DigestInfo variants,
 * signatures that are not below the modulus, the wrong length or zero. Only a
 * `valid` one may verify. `acceptable` is a DigestInfo missing its NULL, which
 * is refused as well: the whole block is compared, so there is no lenient
 * parse. A refusal can be `false` or an assert.
 */
describe.each(Object.entries(vectors.files))('Wycheproof %s', (file, groups) => {
  const hash = file.includes('sha512') ? 'sha512' : 'sha256'
  const cases = groups.flatMap(({ modulus, exponent, tests }) => {
    const hint = montgomeryHint(Buffer.from(modulus, 'hex'))
    return (tests as Test[]).map(([tcId, result, comment, msg, sig]) => ({ tcId, result, comment, msg, sig, modulus, exponent, hint }))
  })

  it.each(cases)('$tcId $result $comment', ({ result, msg, sig, modulus, exponent, hint }) => {
    const consumer = ctx.contract.create(RsaConsumer)
    const args = [
      Bytes(new Uint8Array(digestHex(hash, msg))),
      Bytes.fromHex(sig),
      Bytes.fromHex(modulus),
      Bytes.fromHex(exponent),
      Bytes(new Uint8Array(hint)),
    ] as const

    let accepted: boolean
    try {
      accepted = hash === 'sha512' ? consumer.verifySha512(...args) : consumer.verifySha256(...args)
    } catch {
      accepted = false
    }

    expect(accepted).toBe(result === 'valid')
  })
})
