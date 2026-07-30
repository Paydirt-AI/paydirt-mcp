import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

function mcpClient(process) {
  let id = 0;
  let buffered = '';
  const pending = new Map();

  process.stdout.setEncoding('utf8');
  process.stdout.on('data', (chunk) => {
    buffered += chunk;
    let lineEnd;
    while ((lineEnd = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, lineEnd).trim();
      buffered = buffered.slice(lineEnd + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  });

  return {
    request(method, params) {
      const requestId = ++id;
      process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Timed out waiting for ${method}`));
        }, 5_000);
        pending.set(requestId, {
          resolve(value) {
            clearTimeout(timeout);
            resolve(value);
          },
        });
      });
    },
    notify(method, params = {}) {
      process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
  };
}

function toolJson(response) {
  assert.equal(response.error, undefined);
  return JSON.parse(response.result.content[0].text);
}

test('setup is a non-blocking begin/finish flow and stores credentials owner-only', async (t) => {
  const fakeHome = await mkdtemp(join(tmpdir(), 'paydirt-mcp-test-'));
  const child = spawn(process.execPath, ['--import', './test/setup-mock-fetch.mjs', 'dist/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, HOME: fakeHome, PAYDIRT_API_URL: 'https://mock.paydirt.invalid', PAYDIRT_AUTH_TOKEN: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  const client = mcpClient(child);

  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'setup-test', version: '1.0.0' },
  });
  client.notify('notifications/initialized');

  const startedAt = Date.now();
  const begin = toolJson(await client.request('tools/call', {
    name: 'paydirt_begin_setup',
    arguments: {
      app_name: 'Example',
      bundle_id: 'com.example.app',
      use_cases: ['regular_feedback'],
      subscription_provider: 'none',
    },
  }));
  assert.ok(Date.now() - startedAt < 2_000, 'begin setup should return immediately');
  assert.equal(begin.status, 'authorization_required');
  assert.equal(begin.session_id, 'setup-session');
  assert.match(begin.authorization_url, /^https:\/\/www\.paydirt\.ai\/setup\?/);
  assert.equal(begin.finish_arguments.session_id, 'setup-session');
  assert.equal(begin.finish_arguments.bundle_id, 'com.example.app');

  const pending = toolJson(await client.request('tools/call', {
    name: 'paydirt_finish_setup',
    arguments: begin.finish_arguments,
  }));
  assert.equal(pending.status, 'pending');

  const ready = toolJson(await client.request('tools/call', {
    name: 'paydirt_finish_setup',
    arguments: begin.finish_arguments,
  }));
  assert.equal(ready.status, 'ready');
  assert.equal(ready.installation.app_id, 'app-123');
  assert.equal(ready.installation.ios.subscription.provider, 'none');

  const credentialPath = join(fakeHome, '.paydirt', 'credentials.json');
  const credentials = JSON.parse(await readFile(credentialPath, 'utf8'));
  assert.equal(credentials.auth_token, 'private-user-token');
  assert.equal((await stat(join(fakeHome, '.paydirt'))).mode & 0o777, 0o700);
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
});
