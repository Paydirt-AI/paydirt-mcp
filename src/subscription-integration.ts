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
  const integrationBase = 'https://raw.githubusercontent.com/Paydirt-AI/paydirt-ios/2.0.4/IntegrationTemplates';

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
        minimum_revenuecat_version: null,
        upgrade_required: false,
        version_policy: 'use_host_installed_version',
        integration_source_url: `${integrationBase}/PaydirtRevenueCatAdapter.swift`,
        setup_code: `Paydirt.enableRevenueCatIntegration(\n    ${forms}\n)`,
        compatibility_fallback: {
          strategy: 'adapt_to_host_revenuecat_api',
          rule: 'If the template references RevenueCat APIs that are newer than the installed version, adapt the copied source to the symbols available in that installed package or call Paydirt.handleSubscriptionCancellation from the app\'s existing RevenueCat customer-info/cancellation path.',
          optional_metadata: 'Omit unavailable price, period, store, ownership, or unsubscribe-date fields. Missing optional metadata must not block the trial or subscription cancellation conversation.',
        },
        instructions: [
          'Keep the host app\'s existing RevenueCat package and version; Paydirt itself does not depend on RevenueCat.',
          'An older RevenueCat version is not a blocker and must not be upgraded solely for Paydirt.',
          'Inspect the installed RevenueCat source and the host app\'s existing customer-info, purchaser-info, delegate, or cancellation code. Adapt the copied adapter to the API names and callback style that already compile in this app.',
          'Add the supplied RevenueCat integration source to the host target automatically, then call the setup code after Purchases and Paydirt are configured. Do not ask the developer to copy it.',
          'The integration preserves and forwards to the existing Purchases delegate.',
          'If the installed version lacks newer product or metadata APIs, omit those optional fields and keep cancellation detection working from the renewal state the app already reads.',
          'If adapting the delegate is unsafe, call Paydirt.handleSubscriptionCancellation from the app\'s existing confirmed RevenueCat cancellation/customer-info path instead. Do not replace the purchase flow or switch providers because the SDK is old.',
        ],
      };
    case 'superwall':
      return {
        provider: 'superwall',
        automatic_detection: true,
        minimum_superwall_version: '4.11.0',
        integration_source_url: `${integrationBase}/PaydirtSuperwallAdapter.swift`,
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
          'Choose revenuecat whenever the app already uses RevenueCat. Otherwise choose storekit for native App Store subscriptions, including apps that use Superwall only for paywalls. Choose superwall only when its CustomerInfo API is already the subscription source of truth, and custom only when the app already exposes its own confirmed cancellation event.',
          'Do not guess from a paywall UI alone. RevenueCat is the source of truth when Superwall sits on top of RevenueCat.',
          'Then apply the matching provider contract and build the real host target.',
        ],
      };
  }
}
