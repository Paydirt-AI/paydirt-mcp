import assert from 'node:assert/strict';
import test from 'node:test';

import {
  feedbackPlacementContract,
  findCustomFormByName,
  normalizedFormName,
} from '../dist/form-placement.js';

test('normalizes form titles for idempotent matching', () => {
  assert.equal(normalizedFormName('  Beta   Feedback  '), 'beta feedback');
  assert.equal(
    findCustomFormByName([
      { id: 'other', name: 'Beta Feedback', type: 'cancellation' },
      { id: 'match', name: 'BETA  feedback', type: 'custom' },
    ], ' beta feedback ')?.id,
    'match'
  );
});

test('returns an exact, escaped Swift statement and mandatory verification actions', () => {
  const contract = feedbackPlacementContract(
    {
      id: 'form-123',
      name: 'Post-save feedback',
      type: 'custom',
      prompt: 'How did that go?',
      slack_channel_id: null,
    },
    'after saving a "favorite"',
    'in_app_action',
    'created',
    { status: 'channel_required' }
  );

  assert.equal(
    contract.ios.presentation_statement,
    'Paydirt.presentForm(formId: "form-123", metadata: ["paydirt_placement": "after saving a \\"favorite\\""])'
  );
  assert.match(contract.ios.placement_instruction, /successful completion path/);
  assert.equal(contract.completion_requirements.host_app_build_passed, true);
  assert.equal(contract.completion_requirements.slack_channel_assigned, true);
});
