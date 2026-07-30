import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeSubscriptionProvider,
  subscriptionIntegrationContract,
} from '../dist/subscription-integration.js';

test('uses explicit providers and preserves the legacy RevenueCat flag', () => {
  assert.equal(normalizeSubscriptionProvider('superwall', true), 'superwall');
  assert.equal(normalizeSubscriptionProvider(undefined, true), 'revenuecat');
  assert.equal(normalizeSubscriptionProvider(undefined, false), 'auto');
});

test('returns native StoreKit code with product and form IDs', () => {
  const contract = subscriptionIntegrationContract({
    provider: 'storekit',
    productIds: ['pro.monthly', 'pro.yearly'],
    cancellationFormId: 'paid-form',
    trialCancellationFormId: 'trial-form',
  });
  assert.match(contract.setup_code, /Paydirt\.enableStoreKitIntegration/);
  assert.match(contract.setup_code, /"pro\.monthly"/);
  assert.match(contract.setup_code, /"trial-form"/);
});

test('keeps third-party billing packages outside the Paydirt core', () => {
  const revenueCat = subscriptionIntegrationContract({ provider: 'revenuecat' });
  const superwall = subscriptionIntegrationContract({ provider: 'superwall' });
  assert.match(revenueCat.adapter_source_url, /PaydirtRevenueCatAdapter\.swift$/);
  assert.match(superwall.adapter_source_url, /PaydirtSuperwallAdapter\.swift$/);
  assert.match(revenueCat.instructions.join(' '), /does not depend on RevenueCat/);
  assert.equal(revenueCat.minimum_revenuecat_version, null);
  assert.equal(revenueCat.upgrade_required, false);
  assert.equal(revenueCat.version_policy, 'use_host_installed_version');
  assert.match(revenueCat.instructions.join(' '), /older RevenueCat version is not a blocker/);
  assert.match(revenueCat.compatibility_fallback.rule, /existing RevenueCat customer-info\/cancellation path/);
  assert.match(revenueCat.compatibility_fallback.optional_metadata, /must not block/);
});

test('supports DifferentSDK-style app-owned cancellation events', () => {
  const custom = subscriptionIntegrationContract({ provider: 'custom' });
  assert.match(custom.setup_code, /Paydirt\.handleSubscriptionCancellation/);
  assert.match(custom.instructions.join(' '), /DifferentSDK-style/);
});
