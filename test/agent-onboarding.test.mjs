import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  PAYDIRT_SERVER_INSTRUCTIONS,
  createPaydirtServer,
  deliveryPreferenceForDestinations,
  waitForResponse,
} from '../dist/server.js';

const API = 'https://mock.paydirt.invalid';

function memoryStore(initial) {
  let credentials = initial;
  return { get: () => credentials, set: (next) => { credentials = next; } };
}

// Records every API request and answers from a route table keyed by "METHOD /path".
function mockApi(t, routes) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  process.env.PAYDIRT_API_URL = API;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, query: url.searchParams, body });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json(typeof handler === 'function' ? handler({ body, query: url.searchParams }) : handler);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.PAYDIRT_API_URL;
  });
  return calls;
}

async function connectedClient(t, credentials = { auth_token: 'user-token', app_id: 'app-1' }) {
  const server = createPaydirtServer(memoryStore(credentials));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'onboarding-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(() => client.close());
  return client;
}

function toolText(result) {
  return result.content[0].text;
}

function toolJson(result) {
  return JSON.parse(toolText(result));
}

test('server instructions stay within 1,500 characters and lead with the three starting forms', async (t) => {
  assert.ok(
    PAYDIRT_SERVER_INSTRUCTIONS.length <= 1_500,
    `instructions are ${PAYDIRT_SERVER_INSTRUCTIONS.length} characters`
  );
  const firstSentences = PAYDIRT_SERVER_INSTRUCTIONS.slice(0, 400);
  assert.match(firstSentences, /Subscription Cancellation, Trial Cancellation, Suggest a Feature/);
  assert.match(PAYDIRT_SERVER_INSTRUCTIONS, /nothing to trigger it yet/);
  assert.match(PAYDIRT_SERVER_INSTRUCTIONS, /never ask the human for keys/i);
  assert.match(PAYDIRT_SERVER_INSTRUCTIONS, /paydirt_wait_for_response \(max 90s\)/);

  const client = await connectedClient(t);
  assert.equal(client.getInstructions(), PAYDIRT_SERVER_INSTRUCTIONS);
});

test('destinations map to the app delivery preference', () => {
  assert.equal(deliveryPreferenceForDestinations(['slack', 'claude-code']), 'both');
  assert.equal(deliveryPreferenceForDestinations(['codex', 'slack']), 'both');
  assert.equal(deliveryPreferenceForDestinations(['slack']), 'slack');
  assert.equal(deliveryPreferenceForDestinations(['codex']), 'agents');
  assert.equal(deliveryPreferenceForDestinations(['claude-code', 'codex']), 'agents');
  assert.throws(() => deliveryPreferenceForDestinations([]), /one or more/);
  assert.throws(() => deliveryPreferenceForDestinations(undefined), /one or more/);
  assert.throws(() => deliveryPreferenceForDestinations(['email']), /Unknown destination/);
});

test('paydirt_set_delivery saves the mapped preference with PUT /api/apps/:id', async (t) => {
  const calls = mockApi(t, {
    'PUT /api/apps/app-9': ({ body }) => ({ app: { id: 'app-9', api_key: 'k', feedback_delivery_preference: body.feedback_delivery_preference } }),
    'PUT /api/apps/app-1': ({ body }) => ({ app: { id: 'app-1', api_key: 'k', feedback_delivery_preference: body.feedback_delivery_preference } }),
  });
  const client = await connectedClient(t);

  for (const [destinations, expected] of [
    [['slack', 'codex'], 'both'],
    [['slack'], 'slack'],
    [['claude-code'], 'agents'],
  ]) {
    const result = await client.callTool({ name: 'paydirt_set_delivery', arguments: { app_id: 'app-9', destinations } });
    assert.equal(result.structuredContent.feedback_delivery_preference, expected);
    assert.deepEqual(calls.at(-1).body, { feedback_delivery_preference: expected });
    assert.equal(calls.at(-1).path, '/api/apps/app-9');
  }

  // Without app_id, the app returned by setup in this session is used.
  const sessionApp = await client.callTool({ name: 'paydirt_set_delivery', arguments: { destinations: ['slack'] } });
  assert.equal(sessionApp.structuredContent.app_id, 'app-1');

  const before = calls.length;
  const invalid = await client.callTool({ name: 'paydirt_set_delivery', arguments: { app_id: 'app-9', destinations: ['email'] } });
  assert.match(toolText(invalid), /Unknown destination/);
  assert.equal(calls.length, before, 'invalid destinations never reach the API');
});

test('paydirt_set_slack_channels maps to PUT /api/slack/:app_id/channels and keeps an omitted channel', async (t) => {
  const calls = mockApi(t, {
    'PUT /api/slack/app-1/channels': ({ body }) => ({ success: true, ...body }),
    'GET /api/slack/app-1/status': {
      connected: true,
      feature_channel_id: 'CFEATURE',
      cancellation_channel_id: 'COLDCANCEL',
      assignments: { feature: { assigned: 1, total: 1 }, cancellation: { assigned: 2, total: 2 } },
    },
  });
  const client = await connectedClient(t);

  const both = await client.callTool({
    name: 'paydirt_set_slack_channels',
    arguments: { app_id: 'app-1', feature_channel_id: 'CIDEAS', cancellation_channel_id: 'CCHURN' },
  });
  assert.equal(both.structuredContent.success, true);
  assert.equal(calls.length, 1, 'no status lookup when both channels are supplied');
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].path, '/api/slack/app-1/channels');
  assert.deepEqual(calls[0].body, { feature_channel_id: 'CIDEAS', cancellation_channel_id: 'CCHURN' });

  await client.callTool({ name: 'paydirt_set_slack_channels', arguments: { cancellation_channel_id: 'CCHURN' } });
  assert.equal(calls[1].path, '/api/slack/app-1/status');
  assert.deepEqual(calls[2].body, { feature_channel_id: 'CFEATURE', cancellation_channel_id: 'CCHURN' });

  const empty = await client.callTool({ name: 'paydirt_set_slack_channels', arguments: { app_id: 'app-1' } });
  assert.match(toolText(empty), /Provide feature_channel_id, cancellation_channel_id, or both/);
});

test('paydirt_set_slack_channels needs every channel the installed forms use the first time', async (t) => {
  let status = {
    connected: true,
    feature_channel_id: null,
    cancellation_channel_id: null,
    assignments: { feature: { assigned: 0, total: 1 }, cancellation: { assigned: 0, total: 2 } },
  };
  const calls = mockApi(t, {
    'PUT /api/slack/app-1/channels': ({ body }) => ({ success: true, ...body }),
    'GET /api/slack/app-1/status': () => status,
  });
  const client = await connectedClient(t);
  const put = () => calls.filter((call) => call.method === 'PUT');

  const partial = await client.callTool({ name: 'paydirt_set_slack_channels', arguments: { cancellation_channel_id: 'CCHURN' } });
  assert.match(toolText(partial), /first time routing; pass both feature_channel_id and cancellation_channel_id \(they may be the same channel\)/);
  assert.equal(put().length, 0, 'rejected before calling the API');

  // Only cancellation forms installed: one channel is enough.
  status = { ...status, assignments: { feature: { assigned: 0, total: 0 }, cancellation: { assigned: 0, total: 2 } } };
  await client.callTool({ name: 'paydirt_set_slack_channels', arguments: { cancellation_channel_id: 'CCHURN' } });
  assert.deepEqual(put().at(-1).body, { feature_channel_id: null, cancellation_channel_id: 'CCHURN' });

  // Only feature forms installed: the missing channel is named.
  status = { ...status, assignments: { feature: { assigned: 0, total: 1 }, cancellation: { assigned: 0, total: 0 } } };
  const featureOnly = await client.callTool({ name: 'paydirt_set_slack_channels', arguments: { cancellation_channel_id: 'CCHURN' } });
  assert.match(toolText(featureOnly), /first time routing; pass feature_channel_id\./);
  await client.callTool({ name: 'paydirt_set_slack_channels', arguments: { feature_channel_id: 'CIDEAS' } });
  assert.deepEqual(put().at(-1).body, { feature_channel_id: 'CIDEAS', cancellation_channel_id: null });
  assert.equal(put().length, 2);
});

test('paydirt_list_slack_channels and paydirt_slack_status default to the session app', async (t) => {
  const calls = mockApi(t, {
    'GET /api/slack/app-1/channels': { channels: [{ id: 'CIDEAS', name: 'ideas' }], team_name: 'Acme' },
    'GET /api/slack/app-1/status': { connected: true, team_name: 'Acme' },
    'GET /api/slack/app-9/status': { connected: false, team_name: null },
  });
  const client = await connectedClient(t);
  const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
  for (const name of ['paydirt_list_slack_channels', 'paydirt_slack_status']) {
    assert.deepEqual(tools.get(name).inputSchema.required, [], `${name} app_id is optional`);
  }

  await client.callTool({ name: 'paydirt_list_slack_channels', arguments: {} });
  await client.callTool({ name: 'paydirt_slack_status', arguments: {} });
  await client.callTool({ name: 'paydirt_slack_status', arguments: { app_id: 'app-9' } });
  assert.deepEqual(calls.map((call) => call.path), ['/api/slack/app-1/channels', '/api/slack/app-1/status', '/api/slack/app-9/status']);

  const noApp = await connectedClient(t, { auth_token: 'user-token' });
  const missing = await noApp.callTool({ name: 'paydirt_slack_status', arguments: {} });
  assert.match(toolText(missing), /app_id is required/);
  assert.equal(calls.length, 3);
});

test('paydirt_connect_slack forwards delivery, manual channel selection, and the /slack/connected return path', async (t) => {
  let preference = 'both';
  const calls = mockApi(t, {
    'GET /api/apps/app-1': () => ({ app: { id: 'app-1', api_key: 'k', feedback_delivery_preference: preference } }),
    'GET /api/slack/install': { auth_url: 'https://slack.com/oauth/v2/authorize?state=x' },
  });
  const client = await connectedClient(t);

  const result = await client.callTool({ name: 'paydirt_connect_slack', arguments: {} });
  assert.equal(result.structuredContent.auth_url, 'https://slack.com/oauth/v2/authorize?state=x');
  assert.match(result.structuredContent.instruction, /While I build, connect Slack/);
  const install = calls.find((call) => call.path === '/api/slack/install');
  assert.equal(install.query.get('app_id'), 'app-1');
  assert.equal(install.query.get('delivery'), 'both');
  assert.equal(install.query.get('channel_selection'), 'manual');
  assert.equal(install.query.get('return_to'), '/slack/connected?app_id=app-1');

  await client.callTool({ name: 'paydirt_connect_slack', arguments: { app_id: 'app-1', delivery: 'slack' } });
  assert.equal(calls.at(-1).query.get('delivery'), 'slack');

  // An agents-only or unconfigured app is never silently switched by connecting Slack.
  preference = 'unconfigured';
  await client.callTool({ name: 'paydirt_connect_slack', arguments: { app_id: 'app-1' } });
  assert.equal(calls.at(-1).query.get('delivery'), null);
  assert.equal(calls.at(-1).query.get('channel_selection'), 'manual');
});

function fakeClock(start = Date.parse('2026-10-11T12:00:00.000Z')) {
  let now = start;
  const sleeps = [];
  return {
    sleeps,
    dependencies: {
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
      pollIntervalMs: 3_000,
    },
  };
}

test('paydirt_wait_for_response returns received once a completed response appears', async (t) => {
  let polls = 0;
  const calls = mockApi(t, {
    'GET /api/responses/app/app-1': () => {
      polls += 1;
      return {
        responses: polls < 3 ? [] : [{
          id: 'resp-1',
          form_id: 'form-cancel',
          forms: { name: 'Subscription Cancellation', type: 'cancellation' },
          conversation: [
            { role: 'assistant', content: 'What made you cancel today?' },
            { role: 'user', content: 'Too expensive for how often I use it.' },
          ],
          status: 'completed',
          created_at: '2026-10-11T12:00:05.000Z',
          completed_at: '2026-10-11T12:00:07.000Z',
        }],
      };
    },
  });
  const clock = fakeClock();
  const result = await waitForResponse('user-token', { app_id: 'app-1', form_id: 'form-cancel' }, clock.dependencies);

  assert.equal(result.status, 'received');
  assert.equal(result.response.id, 'resp-1');
  assert.equal(result.response.form_name, 'Subscription Cancellation');
  assert.equal(result.response.answer, 'Too expensive for how often I use it.');
  assert.equal(result.announce, 'Your first response just landed: "Too expensive for how often I use it."');
  assert.deepEqual(clock.sleeps, [3_000, 3_000], 'polls every 3 seconds');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].query.get('status'), 'completed');
  assert.equal(calls[0].query.get('form_id'), 'form-cancel');
  // since defaults to two minutes before the wait started, and filters on completion time.
  assert.equal(calls[0].query.get('completed_from'), '2026-10-11T11:58:00.000Z');
  assert.equal(calls[0].query.has('date_from'), false);
});

test('paydirt_wait_for_response times out within the bound and clamps to 90 seconds', async (t) => {
  const calls = mockApi(t, { 'GET /api/responses/app/app-1': { responses: [] } });

  const short = fakeClock();
  const timedOut = await waitForResponse(
    'user-token',
    { app_id: 'app-1', since: '2026-10-11T11:59:00.000Z', timeout_seconds: 10 },
    short.dependencies
  );
  assert.equal(timedOut.status, 'timed_out');
  assert.equal(timedOut.next, 'ask the human whether they submitted; call again');
  assert.equal(timedOut.since, '2026-10-11T11:59:00.000Z');
  assert.equal(calls[0].query.get('completed_from'), '2026-10-11T11:59:00.000Z');
  assert.ok(short.sleeps.reduce((sum, ms) => sum + ms, 0) <= 10_000);

  const long = fakeClock();
  await waitForResponse('user-token', { app_id: 'app-1', timeout_seconds: 600 }, long.dependencies);
  const waited = long.sleeps.reduce((sum, ms) => sum + ms, 0);
  assert.ok(waited <= 90_000 && waited >= 87_000, `waited ${waited}ms`);

  const fallback = fakeClock();
  await waitForResponse('user-token', { app_id: 'app-1' }, fallback.dependencies);
  const defaultWait = fallback.sleeps.reduce((sum, ms) => sum + ms, 0);
  assert.ok(defaultWait <= 45_000 && defaultWait >= 42_000, `default waited ${defaultWait}ms`);
});

test('paydirt_wait_for_response reads since as UTC, clamps it to now, and rejects invalid values', async (t) => {
  const calls = mockApi(t, { 'GET /api/responses/app/app-1': { responses: [] } });
  const sinceFor = async (since) => {
    const clock = fakeClock();
    return (await waitForResponse('user-token', { app_id: 'app-1', since, timeout_seconds: 1 }, clock.dependencies)).since;
  };

  assert.equal(await sinceFor('2026-10-11T11:59:00'), '2026-10-11T11:59:00.000Z', 'no zone means UTC');
  assert.equal(await sinceFor('2026-10-11 11:59:30.5'), '2026-10-11T11:59:30.500Z');
  assert.equal(await sinceFor('2026-10-11T13:59:00+02:00'), '2026-10-11T11:59:00.000Z');
  assert.equal(await sinceFor('2026-10-11T11:59:00Z'), '2026-10-11T11:59:00.000Z');
  assert.equal(await sinceFor('2026-10-12T00:00:00Z'), '2026-10-11T12:00:00.000Z', 'a future since is clamped to now');

  const before = calls.length;
  for (const invalid of ['yesterday', 'Oct 11 2026 11:59', '2026-13-40T99:00:00', 42, '']) {
    await assert.rejects(
      waitForResponse('user-token', { app_id: 'app-1', since: invalid }, fakeClock().dependencies),
      /since must be an ISO-8601 date-time/
    );
  }
  assert.equal(calls.length, before, 'invalid since never reaches the API');
});

test('paydirt_wait_for_response is exposed as a read-only MCP tool with a bounded timeout', async (t) => {
  mockApi(t, {
    'GET /api/responses/app/app-1': {
      responses: [{ id: 'resp-2', form_id: 'f', conversation: [{ role: 'user', content: 'Dark mode please' }] }],
    },
  });
  const client = await connectedClient(t);
  const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
  const wait = tools.get('paydirt_wait_for_response');
  assert.equal(wait.annotations.readOnlyHint, true);
  assert.equal(wait.inputSchema.properties.timeout_seconds.maximum, 90);
  assert.deepEqual(tools.get('paydirt_set_delivery').inputSchema.properties.destinations.items.enum, ['slack', 'codex', 'claude-code']);
  assert.ok(tools.get('paydirt_set_slack_channels'));

  const result = toolJson(await client.callTool({ name: 'paydirt_wait_for_response', arguments: {} }));
  assert.equal(result.status, 'received');
  assert.equal(result.app_id, 'app-1');
  assert.match(result.announce, /Dark mode please/);
});
