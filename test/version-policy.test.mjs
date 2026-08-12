import assert from 'node:assert/strict';
import test from 'node:test';

import * as api from '../dist/api.js';
import { PAYDIRT_MCP_VERSION, PAYDIRT_MCP_USER_AGENT } from '../dist/version.js';

test('every API request identifies the running Paydirt MCP version', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let request;
  globalThis.fetch = async (input, options = {}) => {
    request = { input: String(input), options };
    return new Response(JSON.stringify({
      installed_version: PAYDIRT_MCP_VERSION,
      latest_version: PAYDIRT_MCP_VERSION,
      minimum_supported_version: '2.3.0',
      update_available: false,
      update_required: false,
      status: 'current',
      update_action: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const policy = await api.getMcpVersionPolicy();
  assert.equal(policy.status, 'current');
  assert.match(request.input, new RegExp(`installed_version=${PAYDIRT_MCP_VERSION.replaceAll('.', '\\.')}`));
  assert.equal(request.options.headers['User-Agent'], PAYDIRT_MCP_USER_AGENT);
  assert.equal(request.options.headers['X-Paydirt-MCP-Version'], PAYDIRT_MCP_VERSION);
});

test('health check reports update guidance without failing supported clients', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/api/apps')) {
      return new Response(JSON.stringify({ apps: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      installed_version: PAYDIRT_MCP_VERSION,
      latest_version: '2.4.0',
      minimum_supported_version: '2.3.0',
      update_available: true,
      update_required: false,
      status: 'update_recommended',
      update_action: 'Restart your coding agent.',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const health = await api.healthCheck('test-token');
  assert.equal(health.status, 'ok');
  assert.equal(health.authenticated, true);
  assert.equal(health.installed_version, PAYDIRT_MCP_VERSION);
  assert.equal(health.update_available, true);
  assert.equal(health.update_required, false);
  assert.equal(health.update_status, 'update_recommended');
  assert.match(health.update_action || '', /Restart/);
});
