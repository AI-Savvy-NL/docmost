import { Injectable } from '@nestjs/common';
import { fetch as outboundFetch } from 'undici';
import type { CustomFetchOptions } from 'openid-client';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { OutboundAgentFactory } from '../../integrations/outbound/outbound-agent.factory';
import { readCappedResponse } from '../integration/utils/provider-fetch';
import { assertOidcIssuer } from './oidc.repo';

@Injectable()
export class WikisavvyOidcHttp {
  constructor(
    private readonly environment: EnvironmentService,
    private readonly agents: OutboundAgentFactory,
  ) {}

  assertTrusted(issuer: string) {
    assertOidcIssuer(issuer);
    const allowed = this.environment
      .getOidcAllowedOrigins()
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      !allowed.length ||
      allowed.some((value) => {
        try {
          assertOidcIssuer(value);
          return new URL(value).origin !== value;
        } catch {
          return true;
        }
      }) ||
      !allowed.includes(new URL(issuer).origin)
    ) {
      throw new Error('SSO issuer origin is not allowed by the server');
    }
  }

  assertEndpoint(issuer: string, endpoint: string) {
    this.assertTrusted(issuer);
    const url = new URL(endpoint);
    if (
      url.protocol !== 'https:' ||
      url.origin !== new URL(issuer).origin ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error('SSO endpoint is not allowed');
    }
  }

  async fetch(
    issuer: string,
    url: string,
    options: CustomFetchOptions,
  ): Promise<Response> {
    this.assertEndpoint(issuer, url);
    const lease = await this.agents.lease(url);
    try {
      const response = await outboundFetch(url, {
        ...options,
        dispatcher: lease.dispatcher,
        redirect: 'manual',
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error('SSO endpoint redirect refused');
      }
      return await readCappedResponse('SSO', response as unknown as Response);
    } finally {
      await lease.release();
    }
  }
}
