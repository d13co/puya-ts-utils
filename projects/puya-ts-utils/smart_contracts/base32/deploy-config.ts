import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import { Base32ConsumerFactory } from '../artifacts/base32/Base32ConsumerClient'

/**
 * Deploys the worked example and has it encode a couple of things, including
 * the deployer's own address — which the contract arrives at from the public key
 * alone, and which should come back reading exactly as it does off chain.
 */
export async function deploy() {
  console.log('=== Deploying Base32Consumer ===')

  const algorand = AlgorandClient.fromEnvironment()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')

  const factory = algorand.client.getTypedAppFactory(Base32ConsumerFactory, {
    defaultSender: deployer.addr,
  })

  const { appClient } = await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' })

  const encoded = await appClient.send.encode({ args: { data: new TextEncoder().encode('foobar') } })
  console.log(`'foobar' encodes to ${encoded.return}`)

  const address = await appClient.send.encodeAddress({
    args: { account: deployer.addr.toString() },
    // Covers the inner application call the method buys its opcode budget with.
    extraFee: AlgoAmount.MicroAlgo(1000),
  })
  console.log(`the deployer, spelled out on chain: ${address.return}`)
  console.log(`                     and off chain: ${deployer.addr.toString()}`)
}
