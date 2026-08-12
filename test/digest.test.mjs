import assert from 'node:assert/strict';
import test from 'node:test';
import { getFeedbackDigest } from '../dist/api.js';

test('builds a read-only daily digest with typed counts and prior-period comparison', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const now = Date.now();
  const response = (id, formId, hoursAgo, summary) => ({
    id,
    form_id: formId,
    app_id: 'app-123',
    user_id_external: null,
    conversation: [{ role: 'user', content: summary }],
    ai_summary: summary,
    suggested_action: null,
    metadata: null,
    status: 'completed',
    created_at: new Date(now - hoursAgo * 3_600_000).toISOString(),
    updated_at: new Date(now - hoursAgo * 3_600_000).toISOString(),
    completed_at: new Date(now - hoursAgo * 3_600_000).toISOString(),
  });

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/api/apps/app-123/forms')) {
      return new Response(JSON.stringify({ forms: [
        { id: 'feature', app_id: 'app-123', name: 'Suggest a Feature', type: 'feature_request', prompt: '', custom_system_prompt: null, slack_channel_id: null, enabled: true, created_at: '' },
        { id: 'trial', app_id: 'app-123', name: 'Trial Cancellation', type: 'trial_expiration', prompt: '', custom_system_prompt: null, slack_channel_id: null, enabled: true, created_at: '' },
        { id: 'subscription', app_id: 'app-123', name: 'Subscription Cancellation', type: 'cancellation', prompt: '', custom_system_prompt: null, slack_channel_id: null, enabled: true, created_at: '' },
      ] }), { status: 200 });
    }
    if (url.includes('/api/apps/app-123/responses?')) {
      return new Response(JSON.stringify({ responses: [
        response('one', 'feature', 1, 'Add shared calendars.'),
        response('two', 'trial', 2, 'Trial was too short.'),
        response('three', 'subscription', 26, 'Price was too high.'),
      ] }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  };

  const digest = await getFeedbackDigest('token', 'app-123', 24);
  assert.deepEqual(digest.counts, {
    total: 2,
    feature_suggestions: 1,
    trial_cancellations: 1,
    subscription_cancellations: 0,
    other_feedback: 0,
  });
  assert.equal(digest.previous_period_total, 1);
  assert.equal(digest.change_from_previous_period, 1);
  assert.equal(digest.items[0].highlight, 'Add shared calendars.');
  assert.equal(digest.truncated, false);
});
