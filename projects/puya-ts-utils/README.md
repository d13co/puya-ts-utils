# @d13co/puya-ts-utils

Algorand TypeScript subroutines for things the AVM will not hand your contract
directly: **keyless accounts**, the **network transaction counter**, **RSA
signature verification**, and **MBR credit accounting**.

```ts
import { createFundedAccount, createUnfundedAccount } from '@d13co/puya-ts-utils/createAccount'
import { getTxnCounter } from '@d13co/puya-ts-utils/getTxnCounter'
import { parseRsaDnskey, verifyRsaSha256 } from '@d13co/puya-ts-utils/rsa'
import { MbrManager } from '@d13co/puya-ts-utils/mbrManager'
```

Each utility is imported from its own subpath. There is no root import: the Puya
compiler rejects re-export barrels, so a single entry point cannot serve more
than one of them.

## Install

```bash
npm install @d13co/puya-ts-utils
```

`@algorandfoundation/algorand-typescript` `>=1.3.0 <2` is a peer dependency, and
you need `@algorandfoundation/puya-ts` `1.3.0` or later to compile.

This package ships **TypeScript source only**. There is no JavaScript build: the
Puya compiler consumes the source and turns it into TEAL along with your own
contract, so `require()`-ing it from Node will not work and is not meant to.

### Unit testing

`@algorandfoundation/algorand-typescript-testing` runs contracts as JavaScript,
and it recognises a contract class only if it extends the same `Contract` your
own contracts do. Version 1.2.0 pins `@algorandfoundation/algorand-typescript`
to 1.2.0, which lands a second copy in the tree and quietly breaks that check
with `Cannot create a contract for class as it does not extend Contract`. Pin
the version down to one copy:

```json
{
  "pnpm": {
    "overrides": {
      "@algorandfoundation/algorand-typescript": "1.3.0"
    }
  }
}
```

Nothing else is needed — the stock AlgoKit `vitest.config.mts` transforms this
package's source along with your own.

---

# createAccount

Mints **keyless accounts** — ordinary Algorand addresses whose private key was
never generated, and which answer only to your contract.

## What it does

Calling either subroutine creates an application and deletes it again inside a
single inner application call. While that application briefly exists it rekeys
its own escrow to your contract. When the call returns, the application is gone
but its address survives as a plain account — one nobody holds a key for —
signed over to you.

## Usage

Both subroutines are called like any other, from anywhere inside a contract:

```ts
import { createFundedAccount, createUnfundedAccount } from '@d13co/puya-ts-utils/createAccount'
import { Account, Contract, Global, GlobalState, itxn, uint64 } from '@algorandfoundation/algorand-typescript'

export class Vault extends Contract {
  escrow = GlobalState<Account>({ key: 'escrow' })

  /** Mint an account and settle its minimum balance yourself. */
  public open(): Account {
    const account = createUnfundedAccount()

    itxn.payment({ receiver: account, amount: Global.minBalance, fee: 0 }).submit()

    this.escrow.value = account
    return account
  }

  /** Or let the subroutine settle it, out of an account you can send from. */
  public openFrom(fundingAccount: Account): Account {
    this.escrow.value = createFundedAccount(fundingAccount)
    return this.escrow.value
  }

  /** Either way, the minted account is yours to spend from. */
  public spend(receiver: Account, amount: uint64): void {
    itxn.payment({ sender: this.escrow.value, receiver, amount, fee: 0 }).submit()
  }
}
```

## API

### `createUnfundedAccount(): Account`

Mints the account and hands it back empty.

An account carrying an auth address owes the 0.1 ALGO minimum balance, and this
one has nothing yet, so **you have to fund it before your call returns**. There
is no rush within the call itself: minimum balances are checked once, when the
top-level application call ends, rather than after each inner transaction, so
the account is free to sit below its minimum in between.

Costs **2 inner transactions** — the application call and the rekey — both
submitted with `fee: 0`, so cover them out of the fee pool.

### `createFundedAccount(fundingAccount: Account): Account`

The same, plus a payment of `Global.minBalance` from `fundingAccount`, so the
account comes back ready to use.

`fundingAccount` has to be one your contract can send from: either its own
escrow (`Global.currentApplicationAddress`) or an account rekeyed to it.
Anything else is rejected by the AVM when the payment is submitted.

Costs **3 inner transactions**.

### `CreateAccount`

The contract behind both subroutines, exported for tests and tooling. You never
deploy it — the subroutines create and delete it on demand — but you may want it
on hand to stub the inner call in unit tests:

```ts
import { CreateAccount } from '@d13co/puya-ts-utils/createAccount'

const spy = new ApplicationSpy(CreateAccount)
spy.on.createAccount((itxnContext) => itxnContext.setReturnValue(someAccount))
ctx.addApplicationSpy(spy)
```

---

# getTxnCounter

Reads the **network transaction counter** — the number the next transaction on
the network will be given. Side-effect: increments the transaction counter by 1.

## What it does

Every application on Algorand is numbered out of one ledger-wide counter that
advances by one for each transaction, inner transactions included. So an
application created right now is handed the counter's current value.

`getTxnCounter` creates a throwaway application and deletes it in the same
inner transaction, purely to see which id it was given, and returns the value
one past it. Nothing is left behind on the ledger.

The application it creates is just a three-byte always-approve program `0x0a8101`
(`#pragma version 10`, `pushint 1`.) It never runs anything; it only needs to exist
 long enough to be numbered.

## Usage

```ts
import { getTxnCounter } from '@d13co/puya-ts-utils/getTxnCounter'
import { Account, Contract, Global, GlobalState, uint64 } from '@algorandfoundation/algorand-typescript'

export class Ticket extends Contract {
  issued = GlobalState<uint64>({ key: 'issued' })

  /** Read the counter, and let the caller pay for it out of the fee pool. */
  public issue(): uint64 {
    this.issued.value = getTxnCounter(Global.zeroAddress)
    return this.issued.value
  }

  /** Or charge it to an account this contract can send from. */
  public issuePaidBy(feePayer: Account): uint64 {
    // feePayer must be rekeyed to this contract's escrow address
    this.issued.value = getTxnCounter(feePayer)
    return this.issued.value
  }
}
```

## API

### `getTxnCounter(feePayer: Account): uint64`

Returns the id one past the application it created, which is what the next
transaction on the network will be numbered.

`feePayer` decides who covers the one inner transaction this costs:

- **`Global.zeroAddress`** submits it with `fee: 0`, sent from your application's
  own escrow. Nothing is spent, and the caller covers it out of the fee pool.
- **any other account** submits it with `fee: Global.minTxnFee`, sent from that
  account, which pays the fee out of its own balance.

A `feePayer` other than the zero address has to be an account your contract can
send from: either its own escrow (`Global.currentApplicationAddress`) or an
account rekeyed to it. Anything else is rejected by the AVM when the inner
transaction is submitted.

Costs **1 inner transaction** either way.

There is no contract class behind this one, so there is nothing to stub with a
typed `ApplicationSpy`. To fix the counter in a unit test, catch the bare create
and fill in the application it would have been given:

```ts
const spy = new ApplicationSpy()
spy.onBareCall([OnCompleteAction.DeleteApplication], (itxnContext) => {
  Object.assign(itxnContext, { createdApp: someApplication })
})
ctx.addApplicationSpy(spy)
```

`ApplicationSpy.onBareCall` is overloaded, and the Puya test transformer rejects
any function type with more than one call signature, so this has to live in a
plain `.ts` file rather than in your `.algo.spec.ts`. See
`smart_contracts/txn_counter/stub-probe.ts` for the worked version.

---

# rsa

Verifies **RSASSA-PKCS1-v1_5 signatures** — DNSSEC algorithms 8 (RSASHA256)
and 10 (RSASHA512) — for keys up to 512 bytes, with exponents up to 4 bytes.

## What it does

The AVM has no modular exponentiation, and its byte math takes operands of at
most 64 bytes. So the signature is raised to the exponent with multi-precision
Montgomery arithmetic over 512-bit limbs.

The expected block, `00 01 FF..FF 00 || DigestInfo || digest`, is then built in
full and compared byte-for-byte with the result. The decrypted block is never
parsed, since a lenient parser is what lets a forgery through when `e = 3`.

Everything is pure: all input is passed in as bytes, and nothing reads state or
boxes. That means the same code compiles into a contract or a logic signature.

It is tested against [Wycheproof](https://github.com/C2SP/wycheproof)'s
RSASSA-PKCS1-v1_5 vectors for 2048-bit keys with SHA-256 and SHA-512: 518
cases, where only the valid signatures verify.

## Program size

Measured by compiling a contract with one ABI method around each, minus the
same contract without the RSA code:

| What the contract calls | Bytes added |
|---|---|
| `verifyRsaSha256` | 1.45 KB |
| `verifyRsaSha256` and `verifyRsaSha512` | 1.6 KB |
| `rsaStart`, `rsaStep` and `rsaFinish` | 1.6 KB |

An app's approval program gets 2 KB per page, with up to 3 extra pages: 8 KB in
all, shared with the clear program. So RSA takes most of a one-page app. Plan
on one extra page (`extraProgramPages: 1`) once your own code is in.

The logic signature example compiles to 1.5 KB. Logic signatures get 1 KB per
transaction, pooled across the group, so size alone needs a group of 2. Budget
needs more.

## Usage

The subroutines take a digest, not the signed data, so hashing is up to you.
For a DNSSEC RRSIG, hash the RRSIG rdata without its signature field, followed
by the RRset in canonical form:

```ts
import { parseRsaDnskey, verifyRsaSha256 } from '@d13co/puya-ts-utils/rsa'
import { assert, Global, LogicSig, op, TransactionType, Txn } from '@algorandfoundation/algorand-typescript'

/**
 * arg 0: SHA-256 of the signed data, arg 1: RRSIG signature,
 * arg 2: DNSKEY public key field, arg 3: Montgomery hint, or empty
 */
export class RrsigVerifier extends LogicSig {
  program(): boolean {
    // Approve only an inert transaction, and say in its note what was checked.
    assert(
      Txn.typeEnum === TransactionType.Payment &&
        Txn.amount === 0 &&
        Txn.fee === 0 &&
        Txn.rekeyTo === Global.zeroAddress &&
        Txn.closeRemainderTo === Global.zeroAddress,
    )
    assert(Txn.note === op.sha256(op.arg(2)).concat(op.arg(0)))
    const [exponent, modulus] = parseRsaDnskey(op.arg(2))
    return verifyRsaSha256(op.arg(0), op.arg(1), modulus, exponent, op.arg(3))
  }
}
```

## The Montgomery hint

Montgomery form needs one constant per key, `R² mod n`, where `R = 2^(512·k)`
and `k` is the modulus length in 64-byte limbs, rounded up. Working it out on
chain is about 50k of the RSA-2048 budget. For a modulus that does not fill its
top limb, such as RSA-1280 or a 2047-bit key, it costs far more.

It depends only on the key, so the prover can compute it off chain and pass it
in as `hint`: `R² mod n`, left-padded to `k` limbs, followed by the quotient
`⌊R / n⌋`, which the check needs. Checking a hint costs about a tenth of
computing it. `@d13co/puya-ts-utils/rsaHint` computes it off chain:

```ts
import { rsaMontgomeryHint } from '@d13co/puya-ts-utils/rsaHint'

const hint = rsaMontgomeryHint(modulus) // Uint8Array
```

**A hostile hint can only make the call fail, never make a signature verify.**
The hint comes from whoever submits the transaction, so it's untrusted. Its
first part is used only once the contract has proved it equals `R² mod n`. For
`h` below `n`, `h·R⁻¹ mod n` is `R mod n` only when `h` is `R² mod n`, and
`q·n + (h·R⁻¹ mod n) = R` holds only when it is `R mod n`. Any other `h` or `q`
fails an assert. A hint that passes is the value the contract would have
computed itself, so the result is the same with it or without it.

Pass empty bytes instead to have `R² mod n` computed on chain.

## Opcode budget

One verification costs far more than the 700 a single application call gets.
Measured on LocalNet:

| Key | Budget, with hint | Budget, R² computed |
|---|---|---|
| RSA-2048, e = 3 | 20k | 65k |
| RSA-1024, e = 65537 | 29k | 41k |
| RSA-1280, e = 65537 | 53k | 292k |
| RSA-2047, e = 65537 | 90k | — |
| RSA-2048, e = 65537 (the root zone KSK) | 92k | 139k |
| RSA-3072, e = 65537 | 189k | 285k |
| RSA-4096, e = 65537 | ~320k: split over groups, below | — |

The cheapest host is a **logic signature**. Logic signature budget is 20,000
per transaction, pooled across the whole group, and program size pools the same
way. The root KSK check passes in a group of 5 transactions with the hint, or 7
without it, and the other transactions can be plain zero-amount payments.

The args, the key among them, come from whoever submits the transaction, and an
application can't read them. So a verified signature on its own proves only
that *some* key signed *some* digest. That's what the note is for: an
application confirms the check by matching `gtxn N Sender` against the
verifier's address **and** `gtxn N Note` against `sha256(trusted key) ‖ digest`.
The transaction checks keep the verifier's address from being rekeyed or
drained by anyone who can produce a valid signature with a key of their own.

Hosted in an **application** instead, the budget has to come from OpUp inner
transactions. At 700 each, RSA-2048 needs about 130 of them.

## RSA-4096: across several groups

RSA-4096 needs more budget than one group can pool, so the check comes in
pieces as well. `rsaStart` validates the input and sets up Montgomery form, and
returns a state. `rsaStep` processes a number of exponent bits at a time.
`rsaFinish` compares the result with the expected block. `rsaPkcs1v15Verify` is
those three calls in a row.

Keep the state in a box between groups: 2136 bytes for RSA-4096. That rules out
a logic signature host, since it cannot read or write boxes. The steps trust the
state: whoever can write it can make anything verify. Keep it where only your
contract writes it, one per caller, so no one can overwrite a verification in
progress. `rsaFinish` takes the key again and asserts that the state was
started with it, so a caller can't start with a key of their own and have the
result pass for yours.

Each box costs about 0.87 ALGO in minimum balance. If the app paid for it, anyone
could drain it by starting verifications and never finishing them. The example
extends [`MbrManager`](#mbrmanager) so the sender pays out of their MBR credits,
and `finish` refunds them.

```ts
import { rsaBitsLeft, rsaFinish, rsaStart, rsaStep, SHA256_DIGEST_INFO } from '@d13co/puya-ts-utils/rsa'
import { MbrManager } from '@d13co/puya-ts-utils/mbrManager'

export class Verifier extends MbrManager {
  state = BoxMap<Account, bytes>({ keyPrefix: 'rsa' })

  public start(signature: bytes, modulus: bytes, exponent: bytes, hint: bytes): void {
    const mbrBefore = Global.currentApplicationAddress.minBalance
    this.state(Txn.sender).delete()
    this.state(Txn.sender).value = rsaStart(signature, modulus, exponent, hint)
    this.manageMbrCredits(mbrBefore)
  }

  public step(bits: uint64): uint64 {
    const state = this.state(Txn.sender)
    state.value = rsaStep(state.value, bits)
    return rsaBitsLeft(state.value)
  }

  public finish(digest: bytes, modulus: bytes, exponent: bytes): boolean {
    const valid = rsaFinish(this.state(Txn.sender).value, digest, modulus, exponent, SHA256_DIGEST_INFO)
    const mbrBefore = Global.currentApplicationAddress.minBalance
    this.state(Txn.sender).delete()
    this.manageMbrCredits(mbrBefore)
    return valid
  }
}
```

For RSA-4096 with a hint and e = 65537, measured on LocalNet:

| Piece | Budget |
|---|---|
| `rsaStart` | 35k |
| `rsaStep`, per bit | 17k for each clear bit, 33k for the last |

That comes to about 320k.

An application group pools at most about 190k: 700 for each of 16 app calls,
plus 700 for each of 256 inner OpUp transactions. Two groups are enough:

- `start` plus 8 bits
- the last 8 bits plus `finish`

`smart_contracts/rsa/consumer.algo.ts` has the worked version, `RsaSplitConsumer`.

## API

### `parseRsaDnskey(publicKey: bytes): [bytes, bytes]`

Splits the public key field of an RSA DNSKEY record (RFC 3110) into
`[exponent, modulus]`. It reads the one-byte exponent length and the three-byte
form alike, and asserts that a modulus follows.

### `verifyRsaSha256(digest, signature, modulus, exponent, hint): boolean`

### `verifyRsaSha512(digest, signature, modulus, exponent, hint): boolean`

Verify a signature over a 32-byte SHA-256 or 64-byte SHA-512 digest. Computing
the digest with `op.sha512` needs AVM 13.

### `rsaPkcs1v15Verify(digest, signature, modulus, exponent, digestInfo, hint): boolean`

The same, with the DER `DigestInfo` prefix supplied by you:
`SHA256_DIGEST_INFO` and `SHA512_DIGEST_INFO` are exported.

### `rsaStart(signature, modulus, exponent, hint): bytes`

### `rsaStep(state, bits): bytes`

### `rsaBitsLeft(state): uint64`

### `rsaFinish(state, digest, modulus, exponent, digestInfo): boolean`

`rsaPkcs1v15Verify` in pieces, for a check that spans groups. `rsaFinish`
asserts if the state has bits left, or was started with a key other than
`modulus` and `exponent`. Pass the key you trust there, not one taken from the
caller's state.

All three return `false` for a well-formed signature that does not match.
**They assert** on malformed input:

- a modulus that is over 512 bytes, even, has a leading zero byte, or is too
  short to hold the block
- a signature whose length differs from the modulus, or that is not below it
- an exponent that is over 4 bytes, even, or below 3
- a Montgomery hint that is wrong, the wrong length, or whose `R² mod n` is not
  below the modulus


### `rsaMontgomeryHint(modulus: Uint8Array): Uint8Array` — off chain

From `@d13co/puya-ts-utils/rsaHint`: the `hint` for `modulus`. It's plain
TypeScript with no AVM types, for your client or prover.

---

# mbrManager

An abstract contract that makes callers pay for the boxes they create. Each
account deposits **MBR credits** up front. When a method changes the app
account's minimum balance, the difference is charged to the sender's credits,
or refunded to them if it went down.

## What it does

The AVM checks the minimum balance only when an app call ends, so a method may
go over it partway through. Snapshot `minBalance` before the state changes,
then call `manageMbrCredits` afterwards. It charges the exact difference, and
you never have to work out box sizes by hand.

## Usage

```ts
import { MbrManager } from '@d13co/puya-ts-utils/mbrManager'
import { Account, BoxMap, bytes, Global, Txn } from '@algorandfoundation/algorand-typescript'

export class Registry extends MbrManager {
  entries = BoxMap<Account, bytes>({ keyPrefix: 'e' })

  public put(value: bytes) {
    const mbrBefore = Global.currentApplicationAddress.minBalance
    this.entries(Txn.sender).value = value
    this.manageMbrCredits(mbrBefore)
  }
}
```

Growing or shrinking a value in place is charged or refunded too, at 400 µALGO
per byte.

Credit boxes are named `'c'` + the account's 32-byte public key. Keep your own
box prefixes distinct from that.

## Warning: users own their boxes

`MbrManager` is built for a model where **each box belongs to one account**, and
only that account's calls create, resize or delete it. Key your boxes by
`Txn.sender`, as above, or store an owner and assert it.

Mixed ownership breaks down. A refund goes to whoever triggers the decrease,
not to whoever paid for the box. If any account can delete a box another
account paid for, the deleter collects the refund. Use `settleMbrCredits` to
refund the owner instead.

**Entries can get stuck, including shared ones.** A refund needs a credit box to
land in (`RCV`). So an account that has called `withdrawCredits` can't delete
its remaining boxes until it deposits again, which costs another 18 900 µALGO
for the credit box (it gets that back on its next withdrawal). The same goes
for a box shared between accounts: whoever deletes it must have a credit box.
Clean up boxes before withdrawing.

## API

### `depositCredits(creditor: Account, txn: gtxn.PaymentTxn)` — ABI

Credits `txn.amount` to `creditor`, who can be any account, not just the sender.
The creditor's credit box costs 18 900 µALGO, and a first deposit pays for it out
of the deposit itself. Fails with `RCV` if the payment does not go to the app,
`AMT` if the amount is zero, and `CRD` if a first deposit is too small to pay
for the box.

### `withdrawCredits()` — ABI

Pays the sender's credits back to them, plus the MBR freed by deleting their
credit box. The inner payment has zero fee, so send `extraFee: 1000`. Fails with
`AMT` if the sender has no credit box. Refunds for boxes deleted after this fail
until the sender deposits again: see the warning above.

### `logCredits(accounts: Account[])` — ABI, readonly

Logs each account's balance as a big-endian uint64, in input order. An account
with no credit box logs an empty line. Simulate it with `allowMoreLogging` to
read many balances in one call.

### `manageMbrCredits(mbrBefore: uint64)` — protected

Charges the MBR increase since `mbrBefore` to the sender's credits (`CRD` if they
do not have enough), or refunds a decrease to them (`RCV` if they have no credit
box). Call it last, after the state changes.

### `settleMbrCredits(account: Account, mbrBefore: uint64)` — protected

The same as `manageMbrCredits`, but it charges or refunds `account` instead of
the sender.

Errors are raised with `loggedAssert`, so they show up as `ERR:CRD`, `ERR:RCV`
and `ERR:AMT`.

---

## Fees

None of these subroutines pays for itself, with one exception: `getTxnCounter`
given a real `feePayer` charges that account directly, and needs nothing extra
from the caller.

Everywhere else, budget the inner transactions into the fee your caller sends —
from an off-chain client that is `extraFee`:

```ts
await appClient.send.open({ args: [], extraFee: AlgoAmount.MicroAlgo(2000) })   // createUnfundedAccount
await appClient.send.issue({ args: [], extraFee: AlgoAmount.MicroAlgo(1000) })  // getTxnCounter
await appClient.send.withdrawCredits({ args: [], extraFee: AlgoAmount.MicroAlgo(1000) }) // mbrManager
```

## Development

This repository is an AlgoKit workspace. The package lives in
`projects/puya-ts-utils`; everything it publishes is in `src/`, and the rest of
the project is the test bench around it.

```bash
algokit project bootstrap all   # install dependencies
pnpm run build                  # compile contracts to TEAL and generate clients
pnpm run test:unit              # algorand-typescript-testing suite
pnpm run test:e2e               # LocalNet suite (needs `algokit localnet start`)
pnpm run check-types
```

`src/` is the whole library: one file per utility, one utility per import
subpath. Each has a worked example under `smart_contracts/` that the suites
drive — `create_account/consumer.algo.ts`, `txn_counter/consumer.algo.ts` and
`rsa/consumer.algo.ts` under both, `mbr_manager/consumer.algo.ts` under e2e only.
See [docs/algokit-getting-started.md](./docs/algokit-getting-started.md) for the
rest of the AlgoKit workflow.

## License

MIT
