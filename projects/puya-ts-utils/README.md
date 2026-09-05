# @d13co/puya-ts-utils

Algorand TypeScript subroutines for things the AVM will not hand your contract
directly: **keyless accounts**, and the **network transaction counter**.

```ts
import { createFundedAccount, createUnfundedAccount } from '@d13co/puya-ts-utils/createAccount'
import { getTxnCounter } from '@d13co/puya-ts-utils/getTxnCounter'
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

## Fees

None of these subroutines pays for itself, with one exception: `getTxnCounter`
given a real `feePayer` charges that account directly, and needs nothing extra
from the caller.

Everywhere else, budget the inner transactions into the fee your caller sends —
from an off-chain client that is `extraFee`:

```ts
await appClient.send.open({ args: [], extraFee: AlgoAmount.MicroAlgo(2000) })   // createUnfundedAccount
await appClient.send.issue({ args: [], extraFee: AlgoAmount.MicroAlgo(1000) })  // getTxnCounter
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
subpath. Each has a worked example under `smart_contracts/` that both suites
drive — `create_account/consumer.algo.ts` and `txn_counter/consumer.algo.ts`.
See [docs/algokit-getting-started.md](./docs/algokit-getting-started.md) for the
rest of the AlgoKit workflow.

## License

MIT
