// Authentik reports a second factor in the signed ID token's `amr` claim
// (`mfa` for OTP/TOTP, `user` for passkey/WebAuthn). SSO is refused without one.
const SECOND_FACTOR_METHODS = ['mfa', 'user'];

export function satisfiesRequiredMfa(amr: readonly string[]): boolean {
  return amr.some((method) => SECOND_FACTOR_METHODS.includes(method));
}
