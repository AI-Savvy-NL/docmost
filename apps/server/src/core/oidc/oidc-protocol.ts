import { Injectable } from '@nestjs/common';
import * as client from 'openid-client';
import { WikisavvyOidcHttp } from './oidc-http';

export interface OidcClientConfiguration {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export interface OidcProof {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
}

@Injectable()
export class WikisavvyOidcProtocol {
  constructor(private readonly http: WikisavvyOidcHttp) {}

  private async configuration(provider: OidcClientConfiguration) {
    this.http.assertTrusted(provider.issuer);
    const config = await client.discovery(
      new URL(provider.issuer),
      provider.clientId,
      {
        client_secret: provider.clientSecret,
        id_token_signed_response_alg: 'RS256',
      },
      client.ClientSecretPost(provider.clientSecret),
      {
        [client.customFetch]: (url, options) =>
          this.http.fetch(provider.issuer, url, options),
        timeout: 10,
        execute: [client.enableNonRepudiationChecks],
      },
    );
    const metadata = config.serverMetadata();
    if (
      metadata.issuer !== provider.issuer ||
      !metadata.id_token_signing_alg_values_supported?.includes('RS256')
    ) {
      throw new Error('SSO issuer metadata does not match');
    }
    for (const endpoint of [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.jwks_uri,
    ]) {
      if (!endpoint) throw new Error('SSO endpoint missing');
      this.http.assertEndpoint(provider.issuer, endpoint);
    }
    return config;
  }

  async check(provider: OidcClientConfiguration) {
    try {
      await this.configuration(provider);
    } catch {
      throw new Error('SSO verification failed');
    }
  }

  async start(provider: OidcClientConfiguration, redirectUri: string) {
    try {
      const callback = new URL(redirectUri);
      if (
        callback.protocol !== 'https:' ||
        callback.search ||
        callback.hash ||
        callback.username ||
        callback.password
      )
        throw new Error();
      const config = await this.configuration(provider);
      const codeVerifier = client.randomPKCECodeVerifier();
      const nonce = client.randomNonce();
      const state = client.randomState();
      const authorizationUrl = client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid',
        state,
        nonce,
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
      }).href;
      return { authorizationUrl, redirectUri, state, nonce, codeVerifier };
    } catch {
      throw new Error('SSO verification failed');
    }
  }

  async complete(
    provider: OidcClientConfiguration,
    callback: URL,
    proof: OidcProof,
  ) {
    try {
      if (callback.origin + callback.pathname !== proof.redirectUri)
        throw new Error();
      const config = await this.configuration(provider);
      const tokens = await client.authorizationCodeGrant(config, callback, {
        expectedState: proof.state,
        expectedNonce: proof.nonce,
        pkceCodeVerifier: proof.codeVerifier,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (
        claims?.iss !== provider.issuer ||
        typeof claims?.sub !== 'string' ||
        !/^[\x20-\x7e]{1,255}$/.test(claims.sub)
      )
        throw new Error();
      return { issuer: provider.issuer, subject: claims.sub };
    } catch {
      throw new Error('SSO verification failed');
    }
  }
}
