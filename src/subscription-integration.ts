export type SubscriptionProvider =
  | 'auto'
  | 'none'
  | 'storekit'
  | 'revenuecat'
  | 'superwall'
  | 'custom';

interface SubscriptionIntegrationInput {
  provider: SubscriptionProvider;
  cancellationFormId?: string;
  trialCancellationFormId?: string;
  productIds?: string[];
}

function swiftOptional(value?: string): string {
  return value ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : 'nil';
}

function formArguments(input: SubscriptionIntegrationInput): string {
  return [
    `cancellationFormId: ${swiftOptional(input.cancellationFormId)}`,
    `trialCancellationFormId: ${swiftOptional(input.trialCancellationFormId)}`,
  ].join(',\n    ');
}

export function normalizeSubscriptionProvider(
  value: unknown,
  legacyUsesRevenueCat: unknown
): SubscriptionProvider {
  const valid: SubscriptionProvider[] = [
    'auto', 'none', 'storekit', 'revenuecat', 'superwall', 'custom',
  ];
  if (typeof value === 'string' && valid.includes(value as SubscriptionProvider)) {
    return value as SubscriptionProvider;
  }
  if (legacyUsesRevenueCat === true) return 'revenuecat';
  if (legacyUsesRevenueCat === false) return 'auto';
  return 'auto';
}

export function subscriptionIntegrationContract(input: SubscriptionIntegrationInput) {
  const forms = formArguments(input);
  const adapterBase = 'https://raw.githubusercontent.com/Paydirt-AI/paydirt-ios/2.0.0/IntegrationTemplates';

  switch (input.provider) {
    case 'none':
      return {
        provider: 'none',
        automatic_detection: false,
        setup_code: null,
        instructions: [
          'Do not add a billing SDK. Manual feedback forms remain fully supported.',
          'If the app later exposes a cancellation event, switch to storekit, revenuecat, superwall, or custom.',
        ],
      };
    case 'storekit': {
      const productIds = input.productIds ?? [];
      const ids = productIds.length > 0
        ? productIds.map((id) => `"${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(', ')
        : '/* discover the app subscription product IDs */';
      return {
        provider: 'storekit',
        automatic_detection: true,
        third_party_dependency: null,
        setup_code: `Paydirt.enableStoreKitIntegration(\n    productIds: [${ids}],\n    ${forms}\n)`,
        instructions: [
          'Use this for apps whose subscription source of truth is native StoreKit 2.',
          'Pass every auto-renewable subscription product ID used by the app.',
          'Paydirt checks verified StoreKit renewal status at startup and whenever the app becomes active.',
        ],
      };
    }
    case 'revenuecat':
      return {
        provider: 'revenuecat',
        automatic_detection: true,
        adapter_source_url: `${adapterBase}/PaydirtRevenueCatAdapter.swift`,
        setup_code: `PaydirtRevenueCatAdapter.shared.start(\n    ${forms}\n)`,
        instructions: [
          'Keep the host app\'s existing RevenueCat package and version; Paydirt itself does not depend on RevenueCat.',
          'Copy PaydirtRevenueCatAdapter.swift into the host target and start it after Purchases and Paydirt are configured.',
          'The adapter preserves and forwards to the existing Purchases delegate.',
        ],
      };
    case 'superwall':
      return {
        provider: 'superwall',
        automatic_detection: true,
        minimum_superwall_version: '4.10.0',
        adapter_source_url: `${adapterBase}/PaydirtSuperwallAdapter.swift`,
        setup_code: `PaydirtSuperwallAdapter.shared.start(\n    ${forms}\n)`,
        instructions: [
          'Use this when Superwall customer info is the subscription source of truth.',
          'Copy PaydirtSuperwallAdapter.swift into the host target and start it after Superwall and Paydirt are configured.',
          'If Superwall delegates purchases to RevenueCat, use the RevenueCat adapter instead so one source of truth drives cancellation detection.',
        ],
      };
    case 'custom':
      return {
        provider: 'custom',
        automatic_detection: 'host_owned',
        setup_code: `Paydirt.handleSubscriptionCancellation(\n    PaydirtSubscriptionCancellation(\n        provider: .custom,\n        productId: productId,\n        userId: currentUserId,\n        isTrial: isTrial,\n        localizedPrice: localizedPrice,\n        billingPeriod: billingPeriod,\n        expirationDate: expirationDate\n    ),\n    ${forms}\n)`,
        instructions: [
          'Call this from the app\'s existing confirmed trial/subscription cancellation path.',
          'This is the DifferentSDK-style integration: the host decides when cancellation happened and Paydirt handles the conversation, persistence, Slack, and metadata.',
        ],
      };
    case 'auto':
      return {
        provider: 'auto',
        automatic_detection: 'agent_must_resolve',
        setup_code: null,
        instructions: [
          'Inspect imports, package dependencies, purchase configuration, and cancellation code before editing.',
          'Choose revenuecat when RevenueCat owns customer subscription state; choose superwall when Superwall customer info owns it; choose storekit for native StoreKit 2; choose custom when the app exposes its own cancellation event; choose none only when cancellation feedback was not requested.',
          'Do not guess from a paywall UI alone. If Superwall uses a RevenueCat purchase controller, choose revenuecat.',
          'Then apply the matching provider contract and build the real host target.',
        ],
      };
  }
}
