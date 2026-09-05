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

test('setup completes in one MCP process without a restart and stores credentials owner-only', async (t) => {
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

  const confirmation = toolJson(await client.request('tools/call', {
    name: 'paydirt_begin_setup',
    arguments: {
      app_id: 'app-123',
      app_name: 'Example',
      bundle_id: 'com.example.app',
      subscription_provider: 'revenuecat',
    },
  }));
  assert.equal(confirmation.status, 'confirmation_required');
  assert.equal(confirmation.confirmation.recommended, 'add_both');
  assert.match(confirmation.message, /Add all three and show them working/);
  assert.equal(confirmation.confirmation.options[0].label, 'Add all three');
  assert.deepEqual(confirmation.confirmation.options.map((option) => option.id), ['add_both', 'cancellation_only', 'customize']);

  const noSubscriptionConfirmation = toolJson(await client.request('tools/call', {
    name: 'paydirt_begin_setup',
    arguments: {
      app_name: 'No Subscription App',
      bundle_id: 'com.example.free',
      subscription_provider: 'none',
    },
  }));
  assert.equal(noSubscriptionConfirmation.status, 'confirmation_required');
  assert.equal(noSubscriptionConfirmation.confirmation.recommended, 'suggest_feature_only');
  assert.match(noSubscriptionConfirmation.message, /cancellation feedback would not have a real trigger/);
  assert.deepEqual(noSubscriptionConfirmation.next_arguments.use_cases, ['feature_request']);

  const startedAt = Date.now();
  const begin = toolJson(await client.request('tools/call', {
    name: 'paydirt_begin_setup',
    arguments: confirmation.next_arguments,
  }));
  assert.ok(Date.now() - startedAt < 2_000, 'begin setup should return immediately');
  assert.equal(begin.status, 'authorization_required');
  assert.equal(begin.session_id, 'setup-session');
  assert.match(begin.authorization_url, /^https:\/\/www\.paydirt\.ai\/setup\?/);
  const authorizationUrl = new URL(begin.authorization_url);
  assert.equal(authorizationUrl.searchParams.get('required_forms'), 'feature_request,trial_expiration,cancellation');
  assert.equal(begin.finish_arguments.session_id, 'setup-session');
  assert.equal(authorizationUrl.searchParams.get('app_id'), 'app-123');
  assert.equal(begin.finish_arguments.app_id, 'app-123');
  assert.equal(begin.finish_arguments.bundle_id, 'com.example.app');
  assert.deepEqual(begin.finish_arguments.use_cases, ['feature_request', 'trial_cancellation', 'subscription_cancellation']);

  const pending = toolJson(await client.request('tools/call', {
    name: 'paydirt_finish_setup',
    arguments: begin.finish_arguments,
  }));
  assert.equal(pending.status, 'pending');

  const wrongApp = await client.request('tools/call', {
    name: 'paydirt_finish_setup',
    arguments: { ...begin.finish_arguments, app_id: 'another-app' },
  });
  assert.equal(toolJson(wrongApp).status, 'error');
  assert.equal(toolJson(wrongApp).success, false);
  assert.match(wrongApp.result.content[0].text, /different app/);
  await assert.rejects(readFile(join(fakeHome, '.paydirt', 'credentials.json')), { code: 'ENOENT' });

  const ready = toolJson(await client.request('tools/call', {
    name: 'paydirt_finish_setup',
    arguments: begin.finish_arguments,
  }));
  assert.equal(ready.status, 'ready');
  assert.equal(ready.installation.app_id, 'app-123');
  assert.equal(ready.installation.ios.subscription.provider, 'revenuecat');
  assert.deepEqual(ready.installation.use_cases, ['feature_request', 'trial_cancellation', 'subscription_cancellation']);
  assert.match(ready.installation.ios.regular_feedback_trigger, /feature-123/);
  assert.equal(ready.installation.ios.feature_request_placement.requested_placement, 'settings');
  assert.equal(ready.installation.ios.install_verification.mode, 'requested_forms_setup_check');
  assert.equal(ready.installation.ios.install_verification.form_id, 'feature-123');
  assert.equal(ready.installation.ios.install_verification.tests.length, 3);
  assert.deepEqual(
    ready.installation.ios.install_verification.tests.map((item) => item.label),
    ['Suggest a Feature', 'Trial Cancellation', 'Subscription Cancellation']
  );
  assert.match(ready.installation.ios.install_verification.presentation, /presentSetupCheck/);
  assert.match(ready.installation.ios.install_verification.presentation, /requiresSlackDelivery: true/);
  assert.match(ready.installation.ios.install_verification.app_ready_body_snippet, /#if DEBUG/);
  assert.match(ready.installation.ios.install_verification.app_ready_body_snippet, /UserDefaults/);
  assert.match(ready.installation.ios.install_verification.app_ready_body_snippet, /feature-123/);
  assert.match(ready.installation.ios.install_verification.repeat_test_reset, /removeObject/);
  assert.match(ready.installation.ios.install_verification.behavior, /3\/3 delivered/);
  assert.match(ready.installation.host_app_preservation.existing_feedback_ui, /Do not replace/);
  assert.ok(ready.installation.agent_actions.some((action) => action.includes('preserving all existing feedback behavior')));
  assert.ok(ready.installation.agent_actions.some((action) => action.includes('leave the Paydirt setup check visibly open')));
  assert.ok(ready.installation.agent_actions.some((action) => action.includes('Verify the Slack status returned by onboarding')));
  assert.equal(ready.installation.delivery.recommended, 'both');
  assert.equal(ready.installation.delivery.selected, 'both');
  assert.deepEqual(ready.installation.delivery.options.map((option) => option.id), ['both', 'slack', 'agents']);
  assert.equal(ready.installation.slack.connected_during_setup, true);
  assert.equal(ready.installation.slack.required_for_setup, true);
  assert.equal(ready.installation.slack.feature_channel.name, 'paydirt-suggest-a-feature');
  assert.equal(ready.installation.slack.cancellation_channel.name, 'paydirt-cancellations');
  assert.equal(ready.installation.slack.all_forms_assigned, true);
  assert.equal(ready.installation.completion_requirements.install_test_setup_visible, true);
  assert.equal(ready.installation.completion_requirements.required_test_submissions, 3);
  assert.equal(ready.installation.completion_requirements.test_deliveries_verified, true);
  assert.equal(ready.installation.completion_requirements.automatic_test_trigger_debug_only, true);
  assert.equal(ready.installation.completion_requirements.delivery_preference_confirmed_during_onboarding, true);
  assert.equal(ready.installation.daily_brief.included_with_coding_agent_delivery, true);
  assert.equal(ready.installation.daily_brief.eligible, true);
  assert.equal(ready.installation.daily_brief.create_after_delivery_tests_pass, true);
  assert.match(ready.installation.daily_brief.selection_disclosure, /includes this read-only daily brief/);
  assert.match(ready.installation.daily_brief.task_prompt, /paydirt_get_feedback_digest/);
  assert.match(ready.installation.daily_brief.task_prompt, /No new Paydirt feedback/);

  const explicitFeedback = toolJson(await client.request('tools/call', {
    name: 'paydirt_begin_setup',
    arguments: {
      app_name: 'Example',
      bundle_id: 'com.example.app',
      use_cases: ['regular_feedback'],
      form_plan_confirmed: true,
      subscription_provider: 'none',
    },
  }));
  const explicitFeedbackUrl = new URL(explicitFeedback.authorization_url);
  assert.equal(explicitFeedbackUrl.searchParams.get('required_forms'), 'custom');
  assert.deepEqual(explicitFeedback.finish_arguments.use_cases, ['regular_feedback']);

  const credentialPath = join(fakeHome, '.paydirt', 'credentials.json');
  const credentials = JSON.parse(await readFile(credentialPath, 'utf8'));
  assert.equal(credentials.auth_token, 'private-user-token');
  assert.equal((await stat(join(fakeHome, '.paydirt'))).mode & 0o777, 0o700);
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
});

for (const [name, useCases, formIds, delivery] of [
  ['both cancellations', ['trial_cancellation', 'subscription_cancellation'], ['trial-123', 'subscription-123'], 'both'],
  ['one feature form', ['feature_request'], ['feature-123'], 'agents'],
]) {
  test(`setup verifies every requested form for ${name} without marking completion before delivery`, async (t) => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'paydirt-mcp-subset-'));
    const child = spawn(process.execPath, ['--import', './test/setup-mock-fetch.mjs', 'dist/index.js'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, HOME: fakeHome, PAYDIRT_API_URL: 'https://mock.paydirt.invalid', PAYDIRT_AUTH_TOKEN: '', TEST_FORM_IDS: formIds.join(','), TEST_DELIVERY: delivery },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => child.kill());
    const client = mcpClient(child);
    await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'subset-test', version: '1' } });
    client.notify('notifications/initialized');
    const args = { session_id: 'setup-session', app_id: 'app-123', use_cases: useCases, subscription_provider: 'revenuecat' };
    assert.equal(toolJson(await client.request('tools/call', { name: 'paydirt_finish_setup', arguments: args })).status, 'pending');
    const result = toolJson(await client.request('tools/call', { name: 'paydirt_finish_setup', arguments: args }));
    const check = result.installation.ios.install_verification;
    assert.deepEqual(check.tests.map((item) => item.form_id), formIds);
    assert.equal(result.installation.completion_requirements.required_test_submissions, formIds.length);
    assert.equal(result.installation.ios.minimum_version, '2.2.0');
    for (const id of formIds) assert.ok(check.presentation.includes(id));
    assert.match(check.presentation, /PaydirtSetupCheckForm/);
    assert.ok(check.presentation.includes(`requiresSlackDelivery: ${delivery !== 'agents'}`));
    assert.doesNotMatch(check.app_ready_body_snippet, /standard\.set\(true/);
    assert.match(check.behavior, /does not prove the real subscription cancellation trigger/);
    if (delivery === 'agents') {
      const incomplete = toolJson(await client.request('tools/call', {
        name: 'paydirt_finish_setup',
        arguments: { ...args, use_cases: ['feature_request', 'trial_cancellation'] },
      }));
      assert.equal(incomplete.status, 'error');
      assert.match(incomplete.message, /without requested forms: trial_expiration/);
    }

  });
}
