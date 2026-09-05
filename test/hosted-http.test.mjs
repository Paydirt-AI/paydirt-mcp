import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHostedMcpApp } from '../dist/http.js';

const silentLogger = { info() {}, warn() {}, error() {} };
const issuerUrl = new URL('https://mcp.paydirt.test');
const resourceUrl = new URL('https://mcp.paydirt.test/mcp');

function oauthProvider() {
  return {
    clientsStore: {
      async getClient() { return undefined; },
      async registerClient(client) {
        return { ...client, client_id: 'test-client', client_id_issued_at: 1 };
      },
    },
    async authorize() { throw new Error('not used'); },
    async challengeForAuthorizationCode() { throw new Error('not used'); },
    async exchangeAuthorizationCode() { throw new Error('not used'); },
    async exchangeRefreshToken() { throw new Error('not used'); },
    async revokeToken() {},
    async verifyAccessToken(token) {
      const match = /^valid-token-(.+)$/.exec(token);
      if (!match) throw new InvalidTokenError('invalid token');
      const userId = match[1];
      return {
        token,
        clientId: 'test-client',
        scopes: ['paydirt:manage'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        resource: resourceUrl,
        extra: {
          userId,
          appId: `app-${userId}`,
          apiToken: `api-token-${userId}`,
        },
      };
    },
  };
}

function hostedOptions(overrides = {}) {
  return {
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: ['https://allowed.example'],
    requestsPerMinute: 100,
    initializeRequestsPerMinute: 10,
    oauthProvider: oauthProvider(),
    issuerUrl,
    resourceUrl,
    logger: silentLogger,
    ...overrides,
  };
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function connect(url, token) {
  const client = new Client({ name: 'paydirt-hosted-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, transport };
}

function toolJson(result) {
  return JSON.parse(result.content[0].text);
}

test('OAuth identity supplies Paydirt credentials and survives a hosted server restart', async (t) => {
  const originalFetch = globalThis.fetch;
  let slackStatusCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (!url.startsWith('https://mock.paydirt.invalid')) return originalFetch(input, init);
    const authorization = new Headers(init.headers).get('authorization');
    if (url.endsWith('/api/setup/ensure-ready')) {
      const userId = authorization?.replace('Bearer api-token-', '');
      return Response.json({
        app: { id: `app-${userId}`, api_key: `public-key-${userId}` },
        action: 'reused',
        forms: [
          { id: `feature-${userId}`, type: 'feature_request', name: 'Suggest a Feature', created: false },
          { id: `trial-${userId}`, type: 'trial_expiration', name: 'Trial Cancellation Feedback', created: false },
          { id: `cancel-${userId}`, type: 'cancellation', name: 'Cancellation Feedback', created: false },
        ],
      });
    }
    if (url.includes('/api/slack/') && url.endsWith('/status')) {
      slackStatusCalls += 1;
      return Response.json({
        connected: true,
        default_channel_id: 'C123',
        default_channel_name: 'paydirt-cancellation-feedback',
        form_count: 3,
        assigned_form_count: 3,
        all_forms_assigned: true,
      });
    }
    if (url.endsWith('/api/apps')) {
      if (!authorization?.startsWith('Bearer api-token-')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      return Response.json({ apps: [{ id: authorization.replace('Bearer api-token-', 'app-') }] });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  };
  process.env.PAYDIRT_API_URL = 'https://mock.paydirt.invalid';
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.PAYDIRT_API_URL;
  });

  const firstServer = await listen(createHostedMcpApp(hostedOptions()));
  const firstAddress = firstServer.address();
  const first = await connect(new URL(`http://127.0.0.1:${firstAddress.port}/mcp`), 'valid-token-alice');

  const tools = await first.client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === 'paydirt_begin_setup'));
  assert.ok(tools.tools.some((tool) => tool.name === 'paydirt_get_responses'));

  const confirmation = toolJson(await first.client.callTool({
    name: 'paydirt_begin_setup',
    arguments: { app_name: 'Hosted Test', subscription_provider: 'none' },
  }));
  assert.equal(confirmation.status, 'confirmation_required');
  assert.deepEqual(confirmation.next_arguments.use_cases, ['feature_request']);

  const wrongApp = toolJson(await first.client.callTool({
    name: 'paydirt_begin_setup',
    arguments: { ...confirmation.next_arguments, app_id: 'app-bob' },
  }));
  assert.equal(wrongApp.status, 'error');
  assert.match(wrongApp.message, /different app/);

  const setup = toolJson(await first.client.callTool({
    name: 'paydirt_begin_setup',
    arguments: confirmation.next_arguments,
  }));
  assert.equal(setup.status, 'ready');
  assert.equal(setup.installation.app_id, 'app-alice');
  assert.equal(setup.installation.ios.install_verification.form_id, 'feature-alice');
  assert.equal(setup.installation.slack.required_for_setup, false);
  assert.equal(slackStatusCalls, 0);

  const apps = toolJson(await first.client.callTool({ name: 'paydirt_list_apps', arguments: {} }));
  assert.equal(apps[0].id, 'app-alice');

  await first.client.close();
  firstServer.closeAllConnections();
  if (firstServer.listening) await close(firstServer);

  const restartedServer = await listen(createHostedMcpApp(hostedOptions()));
  const restartedAddress = restartedServer.address();
  const restarted = await connect(
    new URL(`http://127.0.0.1:${restartedAddress.port}/mcp`),
    'valid-token-alice'
  );
  t.after(async () => {
    await restarted.client.close();
    restartedServer.closeAllConnections();
    if (restartedServer.listening) await close(restartedServer);
  });

  const afterRestart = toolJson(await restarted.client.callTool({ name: 'paydirt_list_apps', arguments: {} }));
  assert.equal(afterRestart[0].id, 'app-alice');
});

test('hosted endpoint publishes OAuth metadata and enforces host, origin, bearer, content, and rate limits', async (t) => {
  const app = createHostedMcpApp(hostedOptions({ requestsPerMinute: 10, initializeRequestsPerMinute: 2 }));
  const httpServer = await listen(app);
  t.after(async () => {
    httpServer.closeAllConnections();
    if (httpServer.listening) await close(httpServer);
  });
  const address = httpServer.address();
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).authorization, 'oauth-2.1');
  assert.equal(health.headers.get('x-powered-by'), null);

  const platformHealth = await fetch(`${base}/healthz`, { headers: { Host: 'railway-health.internal' } });
  assert.equal(platformHealth.status, 200);

  const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(metadata.status, 200);
  const metadataBody = await metadata.json();
  assert.equal(metadataBody.resource, resourceUrl.href.replace(/\/$/, ''));
  assert.deepEqual(metadataBody.scopes_supported, ['paydirt:manage']);

  const authorizationMetadata = await fetch(`${base}/.well-known/oauth-authorization-server`);
  assert.equal(authorizationMetadata.status, 200);
  const authorizationBody = await authorizationMetadata.json();
  assert.equal(authorizationBody.issuer, issuerUrl.href);
  assert.equal(authorizationBody.code_challenge_methods_supported[0], 'S256');
  assert.deepEqual(authorizationBody.token_endpoint_auth_methods_supported, ['none']);
  assert.deepEqual(authorizationBody.revocation_endpoint_auth_methods_supported, ['none']);
  assert.match(authorizationBody.registration_endpoint, /\/register$/);

  const invalidHost = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Host: 'evil.example',
      Authorization: 'Bearer valid-token-alice',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.ok([400, 403].includes(invalidHost.status));

  const invalidOrigin = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Origin: 'https://evil.example',
      Authorization: 'Bearer valid-token-alice',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(invalidOrigin.status, 403);

  const unauthorized = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get('www-authenticate'), /resource_metadata=/);

  const wrongContentType = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer valid-token-alice',
      'Content-Type': 'text/plain',
      Accept: 'application/json, text/event-stream',
    },
    body: '{}',
  });
  assert.equal(wrongContentType.status, 415);

  const wrongAccept = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer valid-token-alice',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(wrongAccept.status, 406);

  const mismatchedRoutingHeader = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer valid-token-alice',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Method': 'tools/list',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
  });
  assert.equal(mismatchedRoutingHeader.status, 400);

  let rateLimited;
  for (let id = 3; id < 18; id += 1) {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-token-alice',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: {} }),
    });
    if (response.status === 429) {
      rateLimited = response;
      break;
    }
  }
  assert.equal(rateLimited?.status, 429);
  assert.ok(rateLimited.headers.get('retry-after'));
});

test('dynamic client registration is independently rate limited', async (t) => {
  const registeredClients = [];
  const provider = oauthProvider();
  provider.clientsStore.registerClient = async (client) => {
    registeredClients.push(client);
    return { ...client, client_id: `client-${registeredClients.length}`, client_id_issued_at: 1 };
  };
  const app = createHostedMcpApp(hostedOptions({ oauthProvider: provider }));
  const httpServer = await listen(app);
  t.after(async () => {
    httpServer.closeAllConnections();
    if (httpServer.listening) await close(httpServer);
  });
  const address = httpServer.address();
  const base = `http://127.0.0.1:${address.port}`;
  let rateLimited;
  for (let id = 0; id < 25; id += 1) {
    const response = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: `test-${id}`,
        redirect_uris: ['http://127.0.0.1/callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
    if (response.status === 429) {
      rateLimited = response;
      break;
    }
  }
  assert.equal(rateLimited?.status, 429);
  assert.ok(rateLimited.headers.get('retry-after'));
  assert.equal((await rateLimited.json()).error, 'temporarily_unavailable');
});
