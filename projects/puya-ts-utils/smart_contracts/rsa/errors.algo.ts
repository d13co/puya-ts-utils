/*
 * Error codes for the RSA example verifiers. Each doc comment is the message: the SDK's
 * error generator reads it from here. Plain `assert` messages, since a logic
 * signature cannot log; see src/rsaErrors.algo.ts.
 */

/** Verifier transaction must be an inert payment: no amount, fee, rekey or close */
export const errNotInert = 'ERR:INERT'
/** Verifier note must be sha256(key) ‖ digest */
export const errNote = 'ERR:NOTE'
/** RSA signature does not verify */
export const errSignature = 'ERR:BADSIG'
/** Finish or cancel the pending RSA verification before withdrawing credits */
export const errPendingVerification = 'ERR:PENDINGRSA'
