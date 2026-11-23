import { satisfiesRequiredMfa } from './oidc-mfa';

describe('SSO second-factor requirement', () => {
  it.each([[['pwd', 'mfa']], [['user']], [['mfa']]])(
    'accepts an authenticator or passkey login: %j',
    (amr) => {
      expect(satisfiesRequiredMfa(amr)).toBe(true);
    },
  );
  it.each([[[]], [['pwd']], [['MFA']], [['sc']]])(
    'rejects a login without a recognised second factor: %j',
    (amr) => {
      expect(satisfiesRequiredMfa(amr)).toBe(false);
    },
  );
});
