import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import { CreateAccountConsumerFactory } from '../artifacts/create_account/CreateAccountConsumerClient'

/**
 * `CreateAccount` itself is never deployed — it only ever exists for the length
 * of the inner application call that creates and deletes it. What gets deployed
 * here is the consumer, which shows the subroutine being driven by a contract.
 */
export async function deploy() {
  console.log('=== Deploying CreateAccountConsumer ===')

  const algorand = AlgorandClient.fromEnvironment()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')

  const factory = algorand.client.getTypedAppFactory(CreateAccountConsumerFactory, {
    defaultSender: deployer.addr,
  })

  const { appClient, result } = await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' })

  if (['create', 'replace'].includes(result.operationPerformed)) {
    // The application pays the minted account's minimum balance out of its own
    // escrow, so it needs a balance to pay it from.
    await algorand.send.payment({
      amount: AlgoAmount.Algo(1),
      sender: deployer.addr,
      receiver: appClient.appAddress,
    })
  }

  // Each mint covers the call itself, the inner create/delete, its nested
  // rekey, and the funding payment.
  const fee = AlgoAmount.MicroAlgo(3000)

  const separately = await appClient.send.mintAndFund({ args: [], extraFee: fee })
  await report('createUnfundedAccount', separately.return!)

  const bySubroutine = await appClient.send.mintFundedBy({
    args: { fundingAccount: appClient.appAddress.toString() },
    extraFee: fee,
  })
  await report('createFundedAccount', bySubroutine.return!)

  async function report(subroutine: string, minted: string) {
    const info = await algorand.account.getInformation(minted)
    console.log(`${subroutine} minted ${minted}`)
    console.log(`  authorised by ${info.authAddr} (the application account)`)
    console.log(`  holding ${info.balance.microAlgo} µALGO`)
  }
}
