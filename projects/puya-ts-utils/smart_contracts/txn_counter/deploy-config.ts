import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import { TxnCounterConsumerFactory } from '../artifacts/txn_counter/TxnCounterConsumerClient'

/**
 * The probe application `getTxnCounter` measures with is never deployed — it
 * only exists for the length of the inner call that creates and deletes it.
 * What gets deployed here is the consumer, which shows the subroutine being
 * driven by a contract.
 */
export async function deploy() {
  console.log('=== Deploying TxnCounterConsumer ===')

  const algorand = AlgorandClient.fromEnvironment()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')

  const factory = algorand.client.getTypedAppFactory(TxnCounterConsumerFactory, {
    defaultSender: deployer.addr,
  })

  const { appClient, result } = await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' })

  if (['create', 'replace'].includes(result.operationPerformed)) {
    // Reading the counter through the application's own escrow is paid for out
    // of that escrow, so it needs a balance to pay it from.
    await algorand.send.payment({
      amount: AlgoAmount.Algo(1),
      sender: deployer.addr,
      receiver: appClient.appAddress,
    })
  }

  // Covering the read out of the fee pool takes one extra transaction's worth
  // of fee: the inner create/delete that measures the counter.
  const fromFeePool = await appClient.send.read({ args: [], extraFee: AlgoAmount.MicroAlgo(1000) })
  console.log(`read() from the fee pool: ${fromFeePool.return}`)

  // Charging it to the application escrow instead needs no extra fee at all.
  const fromEscrow = await appClient.send.readPaidBy({
    args: { feePayer: appClient.appAddress.toString() },
  })
  console.log(`readPaidBy(escrow):       ${fromEscrow.return}`)
}
