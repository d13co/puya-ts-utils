# @d13co/puya-ts-utils

Algorand TypeScript subroutines that mint **keyless accounts** — ordinary Algorand
addresses whose private key was never generated, and which answer only to your
contract.

```ts
import { createFundedAccount, createUnfundedAccount } from '@d13co/puya-ts-utils'
// or
import { createFundedAccount, createUnfundedAccount } from '@d13co/puya-ts-utils/createAccount'
```

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

## What it does

Calling either subroutine creates an application and deletes it again inside a
single inner application call. While that application briefly exists it rekeys
its own escrow to your contract. When the call returns, the application is gone
but its address survives as a plain account — one nobody holds a key for —
signed over to you.

## Usage

Both subroutines are called like any other, from anywhere inside a contract:

```ts
import { createFundedAccount, createUnfundedAccount } from '@d13co/puya-ts-utils'
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
import { CreateAccount } from '@d13co/puya-ts-utils'

const spy = new ApplicationSpy(CreateAccount)
spy.on.createAccount((itxnContext) => itxnContext.setReturnValue(someAccount))
ctx.addApplicationSpy(spy)
```

## Fees

Neither subroutine pays for itself. Budget the inner transactions above into the
fee your caller sends — from an off-chain client that is `extraFee`:

```ts
await appClient.send.open({ args: [], extraFee: AlgoAmount.MicroAlgo(2000) })
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

`src/createAccount.algo.ts` is the whole library.
`smart_contracts/create_account/consumer.algo.ts` is a worked example that both
suites drive. See [docs/algokit-getting-started.md](./docs/algokit-getting-started.md)
for the rest of the AlgoKit workflow.

## License

MIT
