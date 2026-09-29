import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import type { TransactionComposer } from '@algorandfoundation/algokit-utils/types/composer'
import type { TransactionWithSigner } from 'algosdk'

/**
 * Build a maker's group, let `mutate` tamper with it, and send it. `txns` is the
 * live array: mutate fields, splice transactions in or out, or swap signers.
 * Fees are not recomputed, so set them yourself when the mutation changes what
 * the group owes.
 */
export async function sendMutated(
  sdk: { algorand: AlgorandClient },
  builder: TransactionComposer | { composer(): Promise<TransactionComposer> },
  mutate: (txns: TransactionWithSigner[]) => void | Promise<void>,
) {
  const composer = 'composer' in builder ? await builder.composer() : builder
  // clone(): a fresh ATC with group ids cleared; addAtc regroups on send
  const atc = (await composer.build()).atc.clone()
  // @ts-expect-error private
  await mutate(atc.transactions)
  return sdk.algorand.newGroup().addAtc(atc).send()
}
