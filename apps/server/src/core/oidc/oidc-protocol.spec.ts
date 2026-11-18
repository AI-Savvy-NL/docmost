import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { WikisavvyOidcProtocol } from './oidc-protocol';
import { WikisavvyOidcHttp } from './oidc-http';

const issuer = 'https://identity.example.invalid/application/o/wiki/';
const callback = 'https://wiki.example.invalid/api/oidc/callback';
const clientId = 'fixture-client';
const fixtureSecret = 'synthetic-client-proof';
let Protocol: typeof WikisavvyOidcProtocol;
const scoped = process.env.WIKISAVVY_OIDC_TEST_DATABASE_URL
  ? describe
  : describe.skip;
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const wrongKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...keys.publicKey.export({ format: 'jwk' }),
  kid: 'fixture',
  use: 'sig',
  alg: 'RS256',
};

function fixture(failure?: string) {
  const metadata = {
    issuer,
    authorization_endpoint: 'https://identity.example.invalid/authorize',
    token_endpoint: 'https://identity.example.invalid/token',
    jwks_uri: 'https://identity.example.invalid/jwks',
    response_types_supported: ['code'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
  };
  if (failure === 'metadata-issuer')
    metadata.issuer = 'https://wrong.example.invalid/';
  if (failure === 'foreign-token-endpoint')
    metadata.token_endpoint = 'https://foreign.example.invalid/token';
  if (failure === 'foreign-authorization-endpoint')
    metadata.authorization_endpoint =
      'https://foreign.example.invalid/authorize';
  if (failure === 'foreign-jwks')
    metadata.jwks_uri = 'https://foreign.example.invalid/jwks';
  const http = new WikisavvyOidcHttp(
    {
      getOidcAllowedOrigins: () => 'https://identity.example.invalid',
    } as any,
    {} as any,
  );
  let nonce: string;
  let challenge: string;
  let tokenCalls = 0;
  const fetched = jest
    .spyOn(http, 'fetch')
    .mockImplementation(async (_issuer, url, options) => {
      if (url.includes('.well-known/openid-configuration'))
        return Response.json(metadata);
      if (url === metadata.jwks_uri) return Response.json({ keys: [jwk] });
      if (url === metadata.token_endpoint) {
        tokenCalls++;
        const body = new URLSearchParams(options.body as string);
        const pkceMatches =
          createHash('sha256')
            .update(body.get('code_verifier') ?? '')
            .digest('base64url') === challenge;
        if (
          !pkceMatches ||
          body.get('client_secret') !== fixtureSecret ||
          body.get('redirect_uri') !== callback
        ) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        const now = Math.floor(Date.now() / 1000);
        const claims: Record<string, unknown> = {
          iss: issuer,
          sub: 'stable-subject',
          aud: clientId,
          iat: now,
          exp: now + 120,
          nonce,
        };
        if (failure === 'nonce') claims.nonce = 'wrong-nonce';
        if (failure === 'missing-nonce') delete claims.nonce;
        if (failure === 'issuer') claims.iss = 'https://wrong.example.invalid/';
        if (failure === 'audience') claims.aud = 'another-client';
        if (failure === 'expired') {
          claims.iat = now - 3600;
          claims.exp = now - 120;
        }
        if (failure === 'subject') claims.sub = '';
        const header = Buffer.from(
          JSON.stringify({
            alg: failure === 'unsigned' ? 'none' : 'RS256',
            kid: 'fixture',
          }),
        ).toString('base64url');
        const payload = Buffer.from(JSON.stringify(claims)).toString(
          'base64url',
        );
        const input = `${header}.${payload}`;
        const signature = sign(
          'RSA-SHA256',
          Buffer.from(input),
          failure === 'signature' ? wrongKeys.privateKey : keys.privateKey,
        ).toString('base64url');
        const result: Record<string, unknown> = {
          access_token: 'synthetic-access-proof',
          token_type: 'Bearer',
          id_token: `${input}.${signature}`,
        };
        if (failure === 'missing-id-token') delete result.id_token;
        return Response.json(result);
      }
      throw new Error('Unexpected mock issuer request');
    });
  const protocol = new Protocol(http);
  const provider = { issuer, clientId, clientSecret: fixtureSecret };
  async function start() {
    const proof = await protocol.start(provider, callback);
    const authorization = new URL(proof.authorizationUrl);
    nonce = authorization.searchParams.get('nonce')!;
    challenge = authorization.searchParams.get('code_challenge')!;
    return proof;
  }
  return { protocol, provider, start, fetched, calls: () => tokenCalls };
}

scoped(
  'Independent OIDC protocol with real SDK and signed mock issuer responses',
  () => {
    beforeAll(() => {
      Protocol =
        jest.requireActual<typeof import('./oidc-protocol')>(
          './oidc-protocol',
        ).WikisavvyOidcProtocol;
    });
    afterEach(() => jest.restoreAllMocks());

    it('builds S256 code flow and verifies the returned signed identity', async () => {
      const f = fixture();
      const proof = await f.start();
      const authorization = new URL(proof.authorizationUrl);
      expect(authorization.searchParams.get('response_type')).toBe('code');
      expect(authorization.searchParams.get('code_challenge_method')).toBe(
        'S256',
      );
      expect(authorization.searchParams.get('scope')).toBe('openid');
      expect(authorization.searchParams.has('client_secret')).toBe(false);
      const result = await f.protocol.complete(
        f.provider,
        new URL(`${callback}?code=synthetic-code&state=${proof.state}`),
        proof,
      );
      expect(result).toEqual({ issuer, subject: 'stable-subject' });
      expect(f.calls()).toBe(1);
      expect(
        f.fetched.mock.calls.some((call) => call[1].endsWith('/jwks')),
      ).toBe(true);
    });

    it.each([
      'nonce',
      'missing-nonce',
      'issuer',
      'audience',
      'expired',
      'signature',
      'unsigned',
      'subject',
      'missing-id-token',
    ])('rejects an invalid identity proof: %s', async (failure) => {
      const f = fixture(failure);
      const proof = await f.start();
      await expect(
        f.protocol.complete(
          f.provider,
          new URL(`${callback}?code=synthetic-code&state=${proof.state}`),
          proof,
        ),
      ).rejects.toThrow('SSO verification failed');
    });

    it.each(['state', 'pkce', 'provider-error', 'duplicate-state', 'callback'])(
      'rejects authorization binding failures: %s',
      async (failure) => {
        const f = fixture();
        const proof = await f.start();
        const url = new URL(
          `${callback}?code=synthetic-code&state=${proof.state}`,
        );
        if (failure === 'state') url.searchParams.set('state', 'wrong-state');
        if (failure === 'pkce') proof.codeVerifier = 'a'.repeat(43);
        if (failure === 'provider-error') {
          url.searchParams.delete('code');
          url.searchParams.set('error', 'access_denied');
        }
        if (failure === 'duplicate-state')
          url.searchParams.append('state', proof.state);
        if (failure === 'callback') url.pathname = '/different-callback';
        await expect(
          f.protocol.complete(f.provider, url, proof),
        ).rejects.toThrow('SSO verification failed');
      },
    );

    it.each([
      'metadata-issuer',
      'foreign-token-endpoint',
      'foreign-jwks',
      'foreign-authorization-endpoint',
    ])('rejects untrusted discovery metadata: %s', async (failure) => {
      const f = fixture(failure);
      await expect(f.start()).rejects.toThrow('SSO verification failed');
      expect(f.calls()).toBe(0);
    });
  },
);
