#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import { PaydirtOAuthProvider } from './oauth.js';
import {
  createPaydirtServer,
  type CredentialStore,
  type StoredCredentials,
} from './server.js';

import { PAYDIRT_MCP_VERSION as VERSION } from './version.js';
const MANAGE_SCOPE = 'paydirt:manage';
const DEFAULT_ALLOWED_ORIGINS = [
  'https://chatgpt.com',
  'https://chat.openai.com',
  'https://claude.ai',
  'https://claude.com',
  'https://www.paydirt.ai',
];
const DEFAULT_ALLOWED_HOSTS = ['mcp.paydirt.ai', 'localhost', '127.0.0.1', '[::1]'];

class MemoryCredentialStore implements CredentialStore {
  #credentials: StoredCredentials | null;

  constructor(credentials: StoredCredentials) {
    this.#credentials = { ...credentials };
  }

  get(): StoredCredentials | null {
    return this.#credentials;
  }

  set(credentials: StoredCredentials): void {
    this.#credentials = { ...credentials };
  }

  clear(): void {
    this.#credentials = null;
  }
}

interface HostedSession {
  transport: StreamableHTTPServerTransport;
  credentials: MemoryCredentialStore;
  clientId: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface HostedMcpOptions {
  allowedOrigins?: string[];
  allowedHosts?: string[];
  requestsPerMinute?: number;
  initializeRequestsPerMinute?: number;
  sessionTtlMs?: number;
  issuerUrl?: URL;
  resourceUrl?: URL;
  oauthProvider?: OAuthServerProvider;
  now?: () => number;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

function envList(name: string, fallback: string[]): string[] {
  const value = process.env[name];
  if (!value) return fallback;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function envPositiveInteger(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function jsonRpcError(response: Response, status: number, message: string): void {
  response.status(status).json({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  });
}

function clientKey(request: Request): string {
  return request.ip || request.socket.remoteAddress || 'unknown';
}

function requestHeadersMatchBody(request: Request): boolean {
  const body = request.body as { method?: unknown; params?: { name?: unknown; uri?: unknown } } | undefined;
  const method = request.get('mcp-method');
  const name = request.get('mcp-name');
  if (method && body?.method !== method) return false;
  if (name) {
    const bodyName = body?.params?.name ?? body?.params?.uri;
    if (bodyName !== name) return false;
  }
  return true;
}

function authenticatedCredentials(request: Request): StoredCredentials | null {
  const apiToken = request.auth?.extra?.apiToken;
  const appId = request.auth?.extra?.appId;
  if (typeof apiToken !== 'string') return null;
  return {
    auth_token: apiToken,
    app_id: typeof appId === 'string' ? appId : undefined,
    source: 'hosted_oauth',
  };
}

function authenticatedUserId(request: Request): string | null {
  const userId = request.auth?.extra?.userId;
  return typeof userId === 'string' ? userId : null;
}

export function createHostedMcpApp(options: HostedMcpOptions = {}) {
  const allowedOrigins = new Set(options.allowedOrigins ?? envList('MCP_ALLOWED_ORIGINS', DEFAULT_ALLOWED_ORIGINS));
  const allowedHosts = options.allowedHosts ?? envList('MCP_ALLOWED_HOSTS', DEFAULT_ALLOWED_HOSTS);
  const requestsPerMinute = options.requestsPerMinute ?? envPositiveInteger('MCP_REQUESTS_PER_MINUTE', 120);
  const initializeRequestsPerMinute = options.initializeRequestsPerMinute
    ?? envPositiveInteger('MCP_INITIALIZE_REQUESTS_PER_MINUTE', 20);
  const sessionTtlMs = options.sessionTtlMs ?? envPositiveInteger('MCP_SESSION_TTL_SECONDS', 86_400) * 1000;
  const issuerUrl = options.issuerUrl ?? new URL(process.env.MCP_ISSUER_URL || 'https://mcp.paydirt.ai');
  const resourceUrl = options.resourceUrl ?? new URL(process.env.MCP_RESOURCE_URL || `${issuerUrl.origin}/mcp`);
  const oauthProvider = options.oauthProvider ?? new PaydirtOAuthProvider({ resourceUrl });
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const now = options.now ?? Date.now;
  const logger = options.logger ?? console;
  const sessions = new Map<string, HostedSession>();
  const rateLimits = new Map<string, RateLimitEntry>();
  const initializeRateLimits = new Map<string, RateLimitEntry>();
  const oauthRateLimits = new Map<string, RateLimitEntry>();
  const registrationRateLimits = new Map<string, RateLimitEntry>();

  // Railway health checks use an internal Host value that is not stable or
  // customer-controlled. Keep only the inert health endpoint outside the
  // public Host allowlist; every OAuth and MCP route remains protected.
  const app = express();
  app.use(express.json());
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((request, response, next) => {
    response.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  app.get('/healthz', (_request, response) => {
    response.json({
      status: 'ok',
      service: 'paydirt-mcp',
      version: VERSION,
      transport: 'streamable-http',
      authorization: 'oauth-2.1',
      resource: resourceUrl.href,
    });
  });

  const allowedHostSet = new Set(allowedHosts.map((value) => value.toLowerCase()));
  app.use((request, response, next) => {
    if (!allowedHostSet.has(request.hostname.toLowerCase())) {
      response.status(403).json({ error: 'Forbidden host' });
      return;
    }
    next();
  });

  // The SDK metadata helper advertises confidential-client methods even when
  // this server intentionally supports public PKCE clients only. Publish the
  // exact supported methods before mounting the SDK endpoint handlers.
  app.get('/.well-known/oauth-authorization-server', (_request, response) => {
    response.json({
      issuer: issuerUrl.href,
      authorization_endpoint: new URL('/authorize', issuerUrl).href,
      token_endpoint: new URL('/token', issuerUrl).href,
      registration_endpoint: new URL('/register', issuerUrl).href,
      revocation_endpoint: new URL('/revoke', issuerUrl).href,
      scopes_supported: [MANAGE_SCOPE],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      service_documentation: 'https://www.paydirt.ai/docs',
    });
  });

  const applyRateLimit = (
    bucket: Map<string, RateLimitEntry>,
    limit: number,
    request: Request,
    response: Response
  ): boolean => {
    const timestamp = now();
    const key = clientKey(request);
    const current = bucket.get(key);
    const entry = !current || current.resetAt <= timestamp
      ? { count: 0, resetAt: timestamp + 60_000 }
      : current;
    entry.count += 1;
    bucket.set(key, entry);
    response.set({
      'RateLimit-Limit': String(limit),
      'RateLimit-Remaining': String(Math.max(0, limit - entry.count)),
      'RateLimit-Reset': String(Math.ceil(entry.resetAt / 1000)),
    });
    if (entry.count <= limit) return true;
    response.set('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - timestamp) / 1000))));
    jsonRpcError(response, 429, 'Too many requests');
    return false;
  };

  const guardOAuthRequest = (
    bucket: Map<string, RateLimitEntry>,
    limit: number
  ) => (request: Request, response: Response, next: NextFunction) => {
    const timestamp = now();
    const key = clientKey(request);
    const current = bucket.get(key);
    const entry = !current || current.resetAt <= timestamp
      ? { count: 0, resetAt: timestamp + 60_000 }
      : current;
    entry.count += 1;
    bucket.set(key, entry);
    response.set({
      'RateLimit-Limit': String(limit),
      'RateLimit-Remaining': String(Math.max(0, limit - entry.count)),
      'RateLimit-Reset': String(Math.ceil(entry.resetAt / 1000)),
    });
    if (entry.count <= limit) {
      next();
      return;
    }
    response
      .set('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - timestamp) / 1000))))
      .status(429)
      .json({ error: 'temporarily_unavailable', error_description: 'Too many OAuth requests' });
  };

  app.use('/register', guardOAuthRequest(registrationRateLimits, 20));
  app.use(
    ['/authorize', '/token', '/revoke'],
    guardOAuthRequest(oauthRateLimits, 60)
  );
  app.use(mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl,
    baseUrl: issuerUrl,
    resourceServerUrl: resourceUrl,
    scopesSupported: [MANAGE_SCOPE],
    resourceName: 'Paydirt MCP',
    serviceDocumentationUrl: new URL('https://www.paydirt.ai/docs'),
  }));

  const cleanExpiredSessions = async () => {
    const cutoff = now() - sessionTtlMs;
    for (const [sessionId, session] of sessions) {
      if (session.lastSeenAt > cutoff) continue;
      sessions.delete(sessionId);
      session.credentials.clear();
      try {
        await session.transport.close();
      } catch (error) {
        logger.warn('Could not close expired MCP session', error);
      }
    }
  };

  const guardMcpRequest = async (request: Request, response: Response, next: NextFunction) => {
    const origin = request.get('origin');
    if (origin && !allowedOrigins.has(origin)) {
      jsonRpcError(response, 403, 'Forbidden origin');
      return;
    }
    if (origin) {
      response.set({
        'Access-Control-Allow-Origin': origin,
        Vary: 'Origin',
        'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, WWW-Authenticate',
      });
    }
    if (!applyRateLimit(rateLimits, requestsPerMinute, request, response)) return;
    await cleanExpiredSessions();
    next();
  };

  const authenticate = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [MANAGE_SCOPE],
    resourceMetadataUrl,
  });

  app.options('/mcp', (request, response) => {
    const origin = request.get('origin');
    if (!origin || !allowedOrigins.has(origin)) {
      response.status(403).end();
      return;
    }
    response.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, Mcp-Method, Mcp-Name',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    }).status(204).end();
  });

  app.post('/mcp', guardMcpRequest, authenticate, async (request, response) => {
    const contentType = request.get('content-type') || '';
    const accept = request.get('accept') || '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      jsonRpcError(response, 415, 'Content-Type must be application/json');
      return;
    }
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      jsonRpcError(response, 406, 'Accept must include application/json and text/event-stream');
      return;
    }
    if (!requestHeadersMatchBody(request)) {
      jsonRpcError(response, 400, 'MCP routing headers do not match the JSON-RPC body');
      return;
    }

    const credentials = authenticatedCredentials(request);
    const userId = authenticatedUserId(request);
    const clientId = request.auth?.clientId;
    if (!credentials || !userId || !clientId) {
      jsonRpcError(response, 401, 'OAuth token is missing its Paydirt account binding');
      return;
    }

    const sessionHeader = request.get('mcp-session-id');
    const session = sessionHeader ? sessions.get(sessionHeader) : undefined;

    if (!session && !sessionHeader && isInitializeRequest(request.body)) {
      if (!applyRateLimit(initializeRateLimits, initializeRequestsPerMinute, request, response)) return;
      const credentialStore = new MemoryCredentialStore(credentials);
      let transport: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (sessionId) => {
          sessions.set(sessionId, {
            transport,
            credentials: credentialStore,
            clientId,
            userId,
            createdAt: now(),
            lastSeenAt: now(),
          });
        },
      });
      transport.onclose = () => {
        const sessionId = transport.sessionId;
        if (!sessionId) return;
        const closed = sessions.get(sessionId);
        closed?.credentials.clear();
        sessions.delete(sessionId);
      };
      const server = createPaydirtServer(credentialStore);
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
      return;
    }

    if (!session) {
      jsonRpcError(response, sessionHeader ? 404 : 400, 'Invalid or missing MCP session');
      return;
    }
    if (session.clientId !== clientId || session.userId !== userId) {
      jsonRpcError(response, 403, 'This OAuth token does not own the MCP session');
      return;
    }
    session.credentials.set({ ...credentials, api_key: session.credentials.get()?.api_key });
    session.lastSeenAt = now();
    await session.transport.handleRequest(request, response, request.body);
  });

  app.get('/mcp', guardMcpRequest, authenticate, async (request, response) => {
    const accept = request.get('accept') || '';
    if (!accept.includes('text/event-stream')) {
      jsonRpcError(response, 406, 'Accept must include text/event-stream');
      return;
    }
    const sessionId = request.get('mcp-session-id');
    const session = sessionId ? sessions.get(sessionId) : undefined;
    const userId = authenticatedUserId(request);
    if (!session) {
      jsonRpcError(response, sessionId ? 404 : 400, 'Invalid or missing MCP session');
      return;
    }
    if (session.clientId !== request.auth?.clientId || session.userId !== userId) {
      jsonRpcError(response, 403, 'This OAuth token does not own the MCP session');
      return;
    }
    const credentials = authenticatedCredentials(request);
    if (credentials) session.credentials.set({ ...credentials, api_key: session.credentials.get()?.api_key });
    session.lastSeenAt = now();
    await session.transport.handleRequest(request, response);
  });

  app.delete('/mcp', guardMcpRequest, authenticate, async (request, response) => {
    const sessionId = request.get('mcp-session-id');
    const session = sessionId ? sessions.get(sessionId) : undefined;
    const userId = authenticatedUserId(request);
    if (!session) {
      jsonRpcError(response, sessionId ? 404 : 400, 'Invalid or missing MCP session');
      return;
    }
    if (session.clientId !== request.auth?.clientId || session.userId !== userId) {
      jsonRpcError(response, 403, 'This OAuth token does not own the MCP session');
      return;
    }
    sessions.delete(sessionId!);
    session.credentials.clear();
    await session.transport.handleRequest(request, response);
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    logger.error('Hosted MCP request failed', error);
    if (!response.headersSent) jsonRpcError(response, 500, 'Internal server error');
  });

  return app;
}

export function startHostedMcpServer(options: HostedMcpOptions = {}): HttpServer {
  const app = createHostedMcpApp(options);
  const port = envPositiveInteger('PORT', 3002);
  const host = process.env.HOST || '0.0.0.0';
  return app.listen(port, host, () => {
    (options.logger ?? console).info(`Paydirt hosted MCP listening on http://${host}:${port}/mcp`);
  });
}

const isDirectExecution = process.argv[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectExecution) {
  const server = startHostedMcpServer();
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
