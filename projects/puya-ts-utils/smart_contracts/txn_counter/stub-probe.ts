import { type Application, OnCompleteAction } from '@algorandfoundation/algorand-typescript'
import { ApplicationSpy, type TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'

/**
 * Build a stand-in for the probe application's create/delete, which reports back
 * the id it would have been given.
 *
 * The inner call cannot run for real off chain — there is no contract class
 * behind the probe, only three bytes of program — so the emulator is asked for
 * the inner transaction on its way past, and the created application filled in
 * there. `createdApp` is declared readonly on the public type but is a plain
 * field underneath.
 *
 * This lives outside the spec file because `ApplicationSpy.onBareCall` is
 * overloaded, and the Puya test transformer rejects any function type with more
 * than one call signature. Plain `.ts` files are left untransformed, so the spy
 * can be set up here and called from the spec.
 */
export const probeStubber = (ctx: TestExecutionContext) => (created: Application) => {
  const spy = new ApplicationSpy()

  spy.onBareCall([OnCompleteAction.DeleteApplication], (itxnContext) => {
    Object.assign(itxnContext, { createdApp: created })
  })

  ctx.addApplicationSpy(spy)
}
