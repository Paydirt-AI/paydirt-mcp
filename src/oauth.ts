import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

const MANAGE_SCOPE = 'paydirt:manage';

interface IntrospectionResponse {
  active: boolean;
  client_id?: string;
  user_id?: string;
  app_id?: string | null;
  scope?: string[];
  resource?: string;
  expires_at?: string;
  api_token?: string;
}

interface AuthorizationRequestResponse {
  authorization_url: string;
}

interface ChallengeResponse {
  code_challenge: string;
}

export interface PaydirtOAuthProviderOptions {
  apiBaseUrl?: string;
  internalSecret?: string;
  resourceUrl: URL;
}

export class PaydirtOAuthApiClient {
  readonly #baseUrl: string;
  readonly #internalSecret: string;

  constructor(options: Pick<PaydirtOAuthProviderOptions, 'apiBaseUrl' | 'internalSecret'>) {
    this.#baseUrl = (options.apiBaseUrl || process.env.PAYDIRT_API_URL || 'https://api.paydirt.ai').replace(/\/$/, '');
    this.#internalSecret = options.internalSecret || process.env.MCP_OAUTH_INTERNAL_SECRET || '';
    if (!this.#internalSecret) {
      throw new Error('MCP_OAUTH_INTERNAL_SECRET is required for hosted OAuth');
    }
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.#baseUrl}/api/mcp/oauth/internal${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Paydirt-Mcp-Secret': this.#internalSecret,
        ...(init.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof body.error === 'string' ? body.error : 'server_error';
      if (code === 'invalid_grant') throw new InvalidGrantError('The authorization grant is invalid or expired');
      if (code === 'invalid_client' || code === 'invalid_client_metadata') {
        throw new InvalidClientMetadataError('The OAuth client metadata is invalid');
      }
      if (code === 'invalid_request' || code === 'invalid_target' || code === 'invalid_scope') {
        throw new InvalidRequestError('The OAuth request is invalid');
      }
      throw new ServerError('Paydirt authorization service is unavailable');
    }
    return body as T;
  }
}

class PaydirtClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly api: PaydirtOAuthApiClient) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    try {
      return await this.api.request<OAuthClientInformationFull>(`/clients/${encodeURIComponent(clientId)}`);
    } catch (error) {
      if (error instanceof InvalidClientMetadataError) return undefined;
      throw error;
    }
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>
  ): Promise<OAuthClientInformationFull> {
    return this.api.request<OAuthClientInformationFull>('/clients', {
      method: 'POST',
      body: JSON.stringify({
        ...client,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
  }
}

export class PaydirtOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly skipLocalPkceValidation = true;
  readonly #api: PaydirtOAuthApiClient;
  readonly #resourceUrl: URL;

  constructor(options: PaydirtOAuthProviderOptions) {
    this.#api = new PaydirtOAuthApiClient(options);
    this.#resourceUrl = options.resourceUrl;
    this.clientsStore = new PaydirtClientsStore(this.#api);
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    response: Response
  ): Promise<void> {
    if (!params.resource || params.resource.href !== this.#resourceUrl.href) {
      throw new InvalidRequestError('The resource parameter must identify this Paydirt MCP server');
    }
    const authorization = await this.#api.request<AuthorizationRequestResponse>('/authorization-requests', {
      method: 'POST',
      body: JSON.stringify({
        client_id: client.client_id,
        redirect_uri: params.redirectUri,
        state: params.state,
        code_challenge: params.codeChallenge,
        scope: (params.scopes?.length ? params.scopes : [MANAGE_SCOPE]).join(' '),
        resource: params.resource.href,
      }),
    });
    response.redirect(302, authorization.authorization_url);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const result = await this.#api.request<ChallengeResponse>('/authorization-code-challenge', {
      method: 'POST',
      body: JSON.stringify({ client_id: client.client_id, code: authorizationCode }),
    });
    return result.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    return this.#api.request<OAuthTokens>('/token', {
      method: 'POST',
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: authorizationCode,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        resource: resource?.href,
      }),
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    return this.#api.request<OAuthTokens>('/token', {
      method: 'POST',
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: refreshToken,
        scope: scopes?.join(' '),
        resource: resource?.href,
      }),
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const result = await this.#api.request<IntrospectionResponse>('/introspect', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    if (
      !result.active
      || !result.client_id
      || !result.user_id
      || !result.scope
      || !result.resource
      || !result.expires_at
      || !result.api_token
      || result.resource !== this.#resourceUrl.href
    ) {
      throw new InvalidTokenError('The access token is invalid, expired, revoked, or for another resource');
    }
    return {
      token,
      clientId: result.client_id,
      scopes: result.scope,
      expiresAt: Math.floor(new Date(result.expires_at).getTime() / 1000),
      resource: new URL(result.resource),
      extra: {
        userId: result.user_id,
        appId: result.app_id || undefined,
        apiToken: result.api_token,
      },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.#api.request<{ revoked: boolean }>('/revoke', {
      method: 'POST',
      body: JSON.stringify({
        client_id: client.client_id,
        token: request.token,
        token_type_hint: request.token_type_hint,
      }),
    });
  }
}
