import assert from 'node:assert/strict';
import test from 'node:test';
import { PaydirtOAuthProvider } from '../dist/oauth.js';

const resourceUrl = new URL('https://mcp.paydirt.test/mcp');

test('Paydirt OAuth provider delegates durable grants and keeps MCP bearer separate from API identity', async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body, headers: new Headers(init.headers) });
    if (path.endsWith('/clients')) {
      return Response.json({
        ...body,
        client_id: 'client-1',
        client_id_issued_at: 1,
      }, { status: 201 });
    }
    if (path.endsWith('/authorization-requests')) {
      return Response.json({ authorization_url: 'https://www.paydirt.ai/setup?mcp_oauth=request-1' });
    }
    if (path.endsWith('/token')) {
      return Response.json({
        access_token: 'opaque-mcp-access',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'opaque-mcp-refresh',
        scope: 'paydirt:manage',
      });
    }
    if (path.endsWith('/introspect')) {
      return Response.json({
        active: true,
        client_id: 'client-1',
        user_id: 'user-1',
        app_id: 'app-1',
        scope: ['paydirt:manage'],
        resource: resourceUrl.href,
        expires_at: '2030-01-01T00:00:00.000Z',
        api_token: 'separate-short-lived-api-jwt',
      });
    }
    if (path.endsWith('/revoke')) return Response.json({ revoked: true });
    return Response.json({ error: 'not found' }, { status: 404 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = new PaydirtOAuthProvider({
    apiBaseUrl: 'https://api.paydirt.test',
    internalSecret: 'test-internal-secret',
    resourceUrl,
  });
  const client = await provider.clientsStore.registerClient({
    redirect_uris: ['http://127.0.0.1:49152/callback'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
  assert.equal(client.client_id, 'client-1');

  let redirectedTo = '';
  await provider.authorize(client, {
    redirectUri: client.redirect_uris[0],
    codeChallenge: 'a'.repeat(43),
    scopes: ['paydirt:manage'],
    state: 'state-1',
    resource: resourceUrl,
  }, {
    redirect(_status, url) { redirectedTo = url; },
  });
  assert.equal(redirectedTo, 'https://www.paydirt.ai/setup?mcp_oauth=request-1');

  const tokens = await provider.exchangeAuthorizationCode(
    client,
    'authorization-code',
    'v'.repeat(43),
    client.redirect_uris[0],
    resourceUrl
  );
  assert.equal(tokens.access_token, 'opaque-mcp-access');

  const auth = await provider.verifyAccessToken('opaque-mcp-access');
  assert.equal(auth.token, 'opaque-mcp-access');
  assert.equal(auth.extra.apiToken, 'separate-short-lived-api-jwt');
  assert.notEqual(auth.token, auth.extra.apiToken);

  await provider.revokeToken(client, { token: 'opaque-mcp-refresh', token_type_hint: 'refresh_token' });

  assert.ok(calls.every((call) => call.headers.get('x-paydirt-mcp-secret') === 'test-internal-secret'));
  assert.equal(calls.find((call) => call.path.endsWith('/authorization-requests')).body.resource, resourceUrl.href);
  assert.equal(calls.find((call) => call.path.endsWith('/token')).body.code_verifier, 'v'.repeat(43));
  assert.equal(calls.find((call) => call.path.endsWith('/introspect')).body.token, 'opaque-mcp-access');
});
