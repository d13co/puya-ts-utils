import {
  Account,
  assert,
  BoxMap,
  bytes,
  Contract,
  ensureBudget,
  Global,
  LogicSig,
  op,
  TransactionType,
  Txn,
  uint64,
} from '@algorandfoundation/algorand-typescript'
import {
  parseRsaDnskey,
  rsaBitsLeft,
  rsaFinish,
  rsaPkcs1v15Verify,
  rsaStart,
  rsaStep,
  SHA256_DIGEST_INFO,
  verifyRsaSha256,
  verifyRsaSha512,
} from '../../src/rsa.algo'
import { MbrManager } from '../../src/mbrManager.algo'
import { errModulusShort } from '../../src/rsaErrors.algo'
import { errNote, errNotInert, errPendingVerification, errSignature } from './errors.algo'

/**
 * Exercises the RSA subroutines the way a DNSSEC verifier would.
 *
 * Nothing here raises the opcode budget: a single verification needs far more
 * than one application call has, so callers pool it (see the README). The tests
 * run it under simulate with extra budget.
 */
export class RsaConsumer extends Contract {
  /**
   * Check an RSASHA256 RRSIG: hash what it signs, split the DNSKEY key, verify.
   * `hint` is the optional Montgomery hint; empty computes R² on chain.
   */
  public verifyRrsig(signedData: bytes, signature: bytes, publicKey: bytes, hint: bytes): boolean {
    const [exponent, modulus] = parseRsaDnskey(publicKey)
    return verifyRsaSha256(op.sha256(signedData), signature, modulus, exponent, hint)
  }

  public parse(publicKey: bytes): [bytes, bytes] {
    return parseRsaDnskey(publicKey)
  }

  public verifySha256(digest: bytes, signature: bytes, modulus: bytes, exponent: bytes, hint: bytes): boolean {
    return verifyRsaSha256(digest, signature, modulus, exponent, hint)
  }

  public verifySha512(digest: bytes, signature: bytes, modulus: bytes, exponent: bytes, hint: bytes): boolean {
    return verifyRsaSha512(digest, signature, modulus, exponent, hint)
  }

  public verify(
    digest: bytes,
    signature: bytes,
    modulus: bytes,
    exponent: bytes,
    digestInfo: bytes,
    hint: bytes,
  ): boolean {
    return rsaPkcs1v15Verify(digest, signature, modulus, exponent, digestInfo, hint)
  }
}

/**
 * The same check hosted in a logic signature: arg 0 is the SHA-256 digest, arg 1
 * the signature, arg 2 the DNSKEY public key field, arg 3 the Montgomery hint (or empty).
 *
 * Anyone can supply the args, key included, and an app can't read them. So the
 * program approves only an inert transaction (a zero payment, no fee, no rekey,
 * no close) whose note says what was checked: `sha256(key) ‖ digest`. An app
 * that trusts the result matches the sender against this program's address,
 * and the note against the key it trusts and the digest it expects.
 */
export class RsaSha256Verifier extends LogicSig {
  program(): boolean {
    assert(
      Txn.typeEnum === TransactionType.Payment &&
        Txn.amount === 0 &&
        Txn.fee === 0 &&
        Txn.rekeyTo === Global.zeroAddress &&
        Txn.closeRemainderTo === Global.zeroAddress,
      errNotInert,
    )
    assert(Txn.note === op.sha256(op.arg(2)).concat(op.arg(0)), errNote)
    const [exponent, modulus] = parseRsaDnskey(op.arg(2))
    // Asserted rather than returned, so a bad signature fails with a code of its own.
    assert(verifyRsaSha256(op.arg(0), op.arg(1), modulus, exponent, op.arg(3)), errSignature)
    return true
  }
}

/**
 * An RRSIG check too expensive for one group (RSA-4096), run in pieces over
 * several, with the state between them kept in a box.
 *
 * Budget comes from OpUp inner transactions. Each method raises the group's
 * pooled budget to `budget` first, charged to the group's fee credit, so the
 * first call in a group asks for the whole group's. A group pools 700 per app
 * call and 16 inner transaction slots per app call, so `pool` calls pad it out.
 *
 * Each sender gets its own box, so no one else can touch a verification in
 * progress, and `finish` takes the key again, so the result is for that key.
 *
 * The box's minimum balance comes out of the sender's MBR credits: deposit them
 * with `depositCredits` first. `finish` refunds it to the credits.
 */
export class RsaSplitConsumer extends MbrManager {
  /** Each sender's verification in progress. */
  state = BoxMap<Account, bytes>({ keyPrefix: 'rsa' })

  public start(signature: bytes, publicKey: bytes, hint: bytes, budget: uint64): void {
    ensureBudget(budget)
    const [exponent, modulus] = parseRsaDnskey(publicKey)
    // rsaFinish refuses a key too short for the block, and the box would outlive it.
    assert(modulus.length >= SHA256_DIGEST_INFO.length + 32 + 11, errModulusShort)
    const mbrBefore = Global.currentApplicationAddress.minBalance
    this.state(Txn.sender).delete()
    this.state(Txn.sender).value = rsaStart(signature, modulus, exponent, hint)
    this.manageMbrCredits(mbrBefore)
  }

  /** Process up to `bits` more exponent bits, returning how many are left. */
  public step(bits: uint64, budget: uint64): uint64 {
    ensureBudget(budget)
    const state = this.state(Txn.sender)
    state.value = rsaStep(state.value, bits)
    return rsaBitsLeft(state.value)
  }

  /**
   * Check the finished state against `publicKey` and what the RRSIG signs, and
   * clear it. Asserts if the verification was started with another key.
   */
  public finish(signedData: bytes, publicKey: bytes): boolean {
    const [exponent, modulus] = parseRsaDnskey(publicKey)
    const valid = rsaFinish(this.state(Txn.sender).value, op.sha256(signedData), modulus, exponent, SHA256_DIGEST_INFO)
    const mbrBefore = Global.currentApplicationAddress.minBalance
    this.state(Txn.sender).delete()
    this.manageMbrCredits(mbrBefore)
    return valid
  }

  /** Cancel the sender's verification, refunding its state-box MBR to their credits. */
  public cancel(): void {
    const mbrBefore = Global.currentApplicationAddress.minBalance
    this.state(Txn.sender).delete()
    this.manageMbrCredits(mbrBefore)
  }

  /** Withdraw credits only after the sender has finished or cancelled their verification. */
  public override withdrawCredits(): void {
    assert(!this.state(Txn.sender).exists, errPendingVerification)
    super.withdrawCredits()
  }

  /** Does nothing: an app call to pad a group with budget and inner transaction slots. */
  public pool(): void {}
}
