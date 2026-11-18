import { fetch as outboundFetch } from 'undici';
import { WikisavvyOidcHttp } from './oidc-http';

jest.mock('undici', () => ({
  ...jest.requireActual('undici'),
  fetch: jest.fn(),
}));
const issuer = 'https://identity.example.invalid/application/o/wiki/';

function fixture(allowed = 'https://identity.example.invalid') {
  const release = jest.fn(async () => undefined);
  const lease = jest.fn(async () => ({ dispatcher: {} as any, release }));
  const http = new WikisavvyOidcHttp(
    { getOidcAllowedOrigins: () => allowed } as any,
    { lease } as any,
  );
  return { http, lease, release };
}

describe('OIDC pinned HTTPS transport policy', () => {
  beforeEach(() => jest.mocked(outboundFetch).mockReset());

  it.each([
    '',
    '*',
    'https://identity.example.invalid/path',
    'http://identity.example.invalid',
    'https://identity.example.invalid,invalid',
  ])('fails closed for invalid/missing origin policy: %s', async (allowed) => {
    const f = fixture(allowed);
    await expect(
      f.http.fetch(issuer, 'https://identity.example.invalid/token', {
        method: 'POST',
        headers: {},
        body: 'synthetic=fixture',
        redirect: 'manual',
      }),
    ).rejects.toThrow();
    expect(f.lease).not.toHaveBeenCalled();
    expect(outboundFetch).not.toHaveBeenCalled();
  });

  it.each([
    'http://identity.example.invalid/token',
    'https://other.example.invalid/token',
    'https://user:synthetic@identity.example.invalid/token',
    'https://identity.example.invalid/token#fragment',
  ])(
    'rejects untrusted endpoint before opening a connection: %s',
    async (endpoint) => {
      const f = fixture();
      await expect(
        f.http.fetch(issuer, endpoint, {
          method: 'GET',
          headers: {},
          body: undefined,
          redirect: 'manual',
        }),
      ).rejects.toThrow();
      expect(f.lease).not.toHaveBeenCalled();
    },
  );

  it('uses a pinned agent with default TLS verification and refuses redirect following', async () => {
    const f = fixture();
    jest
      .mocked(outboundFetch)
      .mockResolvedValueOnce(Response.json({ ok: true }) as any);
    const response = await f.http.fetch(
      issuer,
      'https://identity.example.invalid/token',
      {
        method: 'POST',
        headers: {},
        body: 'synthetic=fixture',
        redirect: 'manual',
      },
    );
    expect((await response.json()).ok).toBe(true);
    expect(f.lease).toHaveBeenCalledWith(
      'https://identity.example.invalid/token',
    );
    expect(outboundFetch).toHaveBeenCalledWith(
      'https://identity.example.invalid/token',
      expect.objectContaining({
        redirect: 'manual',
        dispatcher: expect.anything(),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('refuses redirects and releases the pinned lease', async () => {
    const f = fixture();
    jest.mocked(outboundFetch).mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://other.example.invalid/' },
      }) as any,
    );
    await expect(
      f.http.fetch(issuer, 'https://identity.example.invalid/token', {
        method: 'GET',
        headers: {},
        body: undefined,
        redirect: 'manual',
      }),
    ).rejects.toThrow('redirect refused');
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(outboundFetch).toHaveBeenCalledTimes(1);
  });

  it('enforces the response size limit', async () => {
    const f = fixture();
    jest.mocked(outboundFetch).mockResolvedValueOnce(
      new Response('fixture', {
        headers: { 'content-length': '99999999' },
      }) as any,
    );
    await expect(
      f.http.fetch(issuer, 'https://identity.example.invalid/token', {
        method: 'GET',
        headers: {},
        body: undefined,
        redirect: 'manual',
      }),
    ).rejects.toThrow();
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('does not fall back when DNS/address policy refuses a lease', async () => {
    const f = fixture();
    f.lease.mockRejectedValueOnce(
      new Error('synthetic-network-policy-refusal'),
    );
    await expect(
      f.http.fetch(issuer, 'https://identity.example.invalid/token', {
        method: 'GET',
        headers: {},
        body: undefined,
        redirect: 'manual',
      }),
    ).rejects.toThrow('synthetic-network-policy-refusal');
    expect(outboundFetch).not.toHaveBeenCalled();
  });
});
