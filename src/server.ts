import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as api from './api.js';
import {
  feedbackPlacementContract,
  findCustomFormByName,
  type FeedbackTrigger,
} from './form-placement.js';
import {
  normalizeSubscriptionProvider,
  subscriptionIntegrationContract,
  type SubscriptionProvider,
} from './subscription-integration.js';
import { PAYDIRT_MCP_VERSION } from './version.js';

export interface StoredCredentials {
  auth_token: string;
  app_id?: string;
  api_key?: string;
  source?: 'hosted_oauth';
}

/**
 * Credential storage is deliberately injected. The stdio entry point uses the
 * existing owner-only file, while each hosted HTTP session uses isolated
 * in-memory storage. This prevents one hosted user's Paydirt token from ever
 * becoming another user's global process credential.
 */
export interface CredentialStore {
  get(): StoredCredentials | null;
  set(credentials: StoredCredentials): void;
  clear?(): void;
}

type PaydirtUseCase = 'regular_feedback' | 'feature_request' | 'trial_cancellation' | 'subscription_cancellation';
type DeliveryPreference = 'both' | 'slack' | 'agents';

const SUPPORTED_USE_CASES: PaydirtUseCase[] = [
  'regular_feedback',
  'feature_request',
  'trial_cancellation',
  'subscription_cancellation',
];

const DEFAULT_USE_CASES: PaydirtUseCase[] = [
  'feature_request',
  'trial_cancellation',
  'subscription_cancellation',
];

function requestedUseCases(value: unknown): PaydirtUseCase[] {
  if (!Array.isArray(value)) return DEFAULT_USE_CASES;
  const valid = value.filter((item): item is PaydirtUseCase =>
    typeof item === 'string' && SUPPORTED_USE_CASES.includes(item as PaydirtUseCase)
  );
  return valid.length > 0 ? [...new Set(valid)] : DEFAULT_USE_CASES;
}

function formTypesForUseCases(useCases: PaydirtUseCase[]): string[] {
  const types = useCases.map((useCase) => {
    if (useCase === 'subscription_cancellation') return 'cancellation';
    if (useCase === 'trial_cancellation') return 'trial_expiration';
    if (useCase === 'feature_request') return 'feature_request';
    return 'custom';
  });
  return [...new Set(types)];
}

function swiftString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function installationContract(
  apiKey: string,
  appId: string,
  forms: Array<Pick<api.Form, 'id' | 'type' | 'name'>>,
  useCases: PaydirtUseCase[],
  subscriptionProvider: SubscriptionProvider,
  subscriptionProductIds: string[],
  featurePlacement: string,
  deliveryPreference: DeliveryPreference,
  slackStatus: Awaited<ReturnType<typeof api.getSlackStatus>> | null
) {
  const includesRegularFeedback = useCases.includes('regular_feedback') || useCases.includes('feature_request');
  const byType = new Map<string, typeof forms[number]>(forms.map((form) => [form.type, form]));
  const cancellationId = byType.get('cancellation')?.id;
  const trialId = byType.get('trial_expiration')?.id;
  const featureRequestId = byType.get('feature_request')?.id;
  const feedbackId = featureRequestId ?? byType.get('custom')?.id;
  const prefetchIds = [cancellationId, trialId, feedbackId].filter(Boolean) as string[];
  const requiresSlackDelivery = deliveryPreference !== 'agents';
  const requestedTypes = formTypesForUseCases(useCases);
  const testForms = requestedTypes.flatMap((type) => {
    const form = byType.get(type);
    return form ? [form] : [];
  });
  const installTestForm = testForms[0];
  const installTestKey = installTestForm
    ? `paydirt.install-test.${appId}.${testForms.map((form) => form.id).sort().join('.')}`
    : null;
  const installTests = testForms.map((form) => ({
    form_id: form.id,
    label: form.type === 'feature_request' ? 'Suggest a Feature'
      : form.type === 'trial_expiration' ? 'Trial Cancellation'
        : form.type === 'cancellation' ? 'Subscription Cancellation' : form.name,
    feedback_type: form.type === 'trial_expiration' ? 'trial_cancellation'
      : form.type === 'cancellation' ? 'subscription_cancellation' : form.type,
    destination: requiresSlackDelivery ? 'customer-selected Slack channel' : 'Paydirt agent responses',
  }));
  const installTestPresentation = installTestForm
    ? `Paydirt.presentSetupCheck(forms: [${installTests.map((item) => `PaydirtSetupCheckForm(formId: "${swiftString(item.form_id)}", title: "${swiftString(item.label)}", feedbackType: "${item.feedback_type}")`).join(', ')}], requiresSlackDelivery: ${requiresSlackDelivery}, completionKey: "${swiftString(installTestKey!)}")`
    : null;
  const installTestSnippet = installTestForm && installTestKey
    ? `#if DEBUG
let paydirtInstallTestKey = "${swiftString(installTestKey)}"
if !UserDefaults.standard.bool(forKey: paydirtInstallTestKey) {
    // The setup check saves this key only after every required delivery is verified.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) {
        ${installTestPresentation}
    }
}
#endif`
    : null;

  const configuration = [
    'import Paydirt',
    '',
    `Paydirt.configure(apiKey: "${apiKey}", theme: .automatic)`,
    prefetchIds.length > 0
      ? `Paydirt.prefetchForms(formIds: [${prefetchIds.map((id) => `"${id}"`).join(', ')}])`
      : null,
  ].filter((line): line is string => line !== null).join('\n');

  const subscription = subscriptionIntegrationContract({
    provider: subscriptionProvider,
    cancellationFormId: cancellationId,
    trialCancellationFormId: trialId,
    productIds: subscriptionProductIds,
  });

  return {
    app_id: appId,
    public_sdk_key: apiKey,
    use_cases: useCases,
    forms: forms.map((form) => ({
      id: form.id,
      name: form.name,
      backend_type: form.type,
      use_case: form.type === 'cancellation'
        ? 'subscription_cancellation'
        : form.type === 'trial_expiration'
          ? 'trial_cancellation'
          : form.type === 'custom'
            ? 'regular_feedback'
            : 'feature_request',
    })),
    ios: {
      package_url: 'https://github.com/Paydirt-AI/paydirt-ios',
      minimum_version: '2.2.0',
      deployment_target: 'iOS 15.0',
      provider_independent_core: true,
      privacy_manifest: 'Bundled in Paydirt; do not copy it into the host app.',
      theming: 'Use .automatic to inherit system light/dark appearance, .light or .dark, or construct PaydirtTheme with app colors.',
      info_plist: {
        NSMicrophoneUsageDescription: 'Used to record voice feedback',
      },
      configuration,
      subscription,
      regular_feedback_trigger: feedbackId
        ? `Paydirt.presentForm(formId: "${feedbackId}", userId: currentUserId)`
        : null,
      feature_request_placement: featureRequestId ? {
        form_id: featureRequestId,
        requested_placement: featurePlacement,
        presentation: `Paydirt.presentForm(formId: "${featureRequestId}", metadata: ["paydirt_placement": "${swiftString(featurePlacement)}"])`,
        behavior: 'Place Suggest a Feature at the confirmed location. Settings is the recommended default; a semantic successful-action trigger may be used when the developer chose one. Preserve the host action and allow this placement to be changed later.',
      } : null,
      install_verification: installTestForm ? {
        required: true,
        mode: 'requested_forms_setup_check',
        form_id: installTestForm.id,
        form_name: installTestForm.name,
        tests: installTests,
        presentation: installTestPresentation,
        app_ready_body_snippet: installTestSnippet,
        repeat_test_reset: `UserDefaults.standard.removeObject(forKey: "${installTestKey}")`,
        behavior: `Add a DEBUG-only one-time app-ready trigger, build and launch on a simulator or connected device, and leave the setup check open. The developer personally submits each requested test. Completion means ${testForms.length}/${testForms.length} ${requiresSlackDelivery ? 'delivered to their selected Slack channels' : 'received by Paydirt'}. Never submit a test for them or include the trigger in release builds. Form delivery verification does not prove the real subscription cancellation trigger; verify each requested trial/paid trigger separately with the host subscription provider.`,
      } : null,
    },
    delivery: {
      selection_required_after_install_verification: false,
      selected: deliveryPreference,
      recommended: 'both',
      prompt: 'The developer selected a delivery destination during browser onboarding. Do not ask again unless they request a change.',
      options: [
        {
          id: 'both',
          label: 'Slack and coding agents',
          recommended: true,
          behavior: 'Connect Slack, assign every installed form, and keep read-only response access available through Paydirt agent tools.',
        },
        {
          id: 'slack',
          label: 'Slack only',
          recommended: false,
          behavior: 'Connect Slack and assign every installed form. Do not proactively surface feedback in agent sessions.',
        },
        {
          id: 'agents',
          label: 'Coding agents only',
          recommended: false,
          behavior: 'Keep responses available through read-only Paydirt agent tools. Do not require or start Slack authorization.',
        },
      ],
      agent_sessions: {
        available_after_setup: true,
        read_only: true,
        rule: 'Do not inject every response into every session and never create tasks or change code automatically. Surface a new-response count or fetch raw responses only when the developer asks.',
      },
    },
    slack: {
      required_for_setup: deliveryPreference === 'both' || deliveryPreference === 'slack',
      connected_during_setup: Boolean(slackStatus?.connected),
      feature_channel: slackStatus ? {
        id: slackStatus.feature_channel_id,
        name: slackStatus.feature_channel_name,
        assignment: slackStatus.assignments.feature,
      } : null,
      cancellation_channel: slackStatus ? {
        id: slackStatus.cancellation_channel_id,
        name: slackStatus.cancellation_channel_name,
        assignment: slackStatus.assignments.cancellation,
      } : null,
      all_forms_assigned: slackStatus?.all_forms_assigned ?? false,
      two_channel_routing: slackStatus?.two_channel_routing ?? false,
      connect_when_selected: ['both', 'slack'],
      next_tools: ['paydirt_connect_slack', 'paydirt_slack_status', 'paydirt_list_slack_channels', 'paydirt_set_form_channel'],
      rule: deliveryPreference === 'agents'
        ? 'Slack was skipped during onboarding. Do not start Slack OAuth unless the developer asks to change delivery.'
        : 'Slack OAuth ran during onboarding. Respect this app owner’s selected workspace and channel assignments. Deliver only completed Q&A, never cancellation-only events or drafts. Repair setup if all_forms_assigned is false.',
    },
    daily_brief: {
      included_with_coding_agent_delivery: deliveryPreference !== 'slack',
      eligible: deliveryPreference !== 'slack',
      create_after_delivery_tests_pass: deliveryPreference !== 'slack',
      recommended_schedule: 'Every day at 9:00 AM in the developer\'s local timezone',
      selection_disclosure: 'Selecting Slack and coding agents or coding agents only includes this read-only daily brief. The developer can pause, edit, or delete it in the host scheduling UI.',
      task_prompt: `Check Paydirt app ${appId} for the last 24 hours using paydirt_get_feedback_digest. Report total new completed feedback, Suggest a Feature count, Trial Cancellation count, Subscription Cancellation count, other feedback count, and the change from the previous 24-hour period. Include concise read-only highlights. If there is no new feedback, say "No new Paydirt feedback in the last 24 hours." Never create coding tasks, edit files, or act on feedback automatically.`,
      host_behavior: {
        codex: 'When the Codex scheduled-task capability is available, create a native daily task after every requested delivery is verified and confirm its local run time.',
        other_agents: 'Create the recurring task after delivery verification only when the current host exposes a real scheduling capability. Otherwise provide the saved task prompt and explain that the host must supply scheduling; do not claim a schedule exists.',
      },
    },
    host_app_preservation: {
      existing_feedback_ui: 'Preserve every existing host-app feedback form, button, screen, handler, and destination. Do not replace, repurpose, remove, or reroute one unless the user explicitly asks for that exact change.',
      regular_feedback: includesRegularFeedback
        ? 'Regular Paydirt feedback was explicitly requested. Add it at the user-approved placement while preserving any existing feedback behavior.'
        : 'Regular Paydirt feedback was not requested. Do not create a custom feedback form or modify any existing feedback UI.',
    },
    agent_actions: [
      'Inspect the iOS project and determine its app entry point, dependency setup, bundle ID, subscription source of truth, product IDs, and cancellation flow.',
      'Preserve all existing host-app feedback forms, buttons, screens, handlers, and destinations. Do not replace, repurpose, remove, or reroute them unless the user explicitly requested that exact change.',
      'Install Paydirt 2.2.0 or newer in the existing dependency style. Paydirt has no third-party package dependency, so preserve the host app\'s existing RevenueCat, Superwall, or StoreKit setup. Do not ask the user to perform Xcode edits that the agent can safely make.',
      'Connect Paydirt to the subscription code already working in the app. Keep the installed provider packages, inspect the APIs already used by the app, adapt the small host-source bridge or use the existing customer-info/cancellation path, and omit unavailable optional metadata rather than blocking installation.',
      'Add NSMicrophoneUsageDescription if it is missing.',
      'Configure Paydirt using the exact public SDK key and form IDs above, then perform every instruction in ios.subscription. If its provider is auto, resolve it from the host source before proceeding.',
      includesRegularFeedback
        ? 'Add regular Paydirt feedback only at the user-approved UI or lifecycle event, preserving all existing feedback behavior. Wire cancellation through the provider contract only when cancellation feedback was requested.'
        : 'Do not create or wire regular feedback and do not modify existing feedback UI. Wire only the requested trial and/or subscription cancellation forms through the provider contract.',
      'Resolve dependencies and build the app. If provider automation cannot compile, report the exact provider blocker and preserve the existing app behavior. Do not add or replace regular feedback as a fallback unless the user explicitly requests it.',
      installTestForm
        ? `After the build succeeds, place ios.install_verification.app_ready_body_snippet inside a safe app-ready lifecycle body. Launch the app on an available simulator or connected development device and leave the Paydirt setup check visibly open so the developer can answer it immediately. Do not submit any test for them, do not run this automatic trigger in release builds, and do not claim installation is complete until the setup check verifies every required delivery.`
        : 'Report that no Paydirt form was returned for immediate install verification and do not claim the form test passed.',
      deliveryPreference === 'agents'
        ? 'Respect the coding-agents-only delivery choice made during onboarding. Do not start Slack OAuth unless the developer asks to change it.'
        : 'Verify the Slack status returned by onboarding: Suggest a Feature must be assigned to the feature channel, and both cancellation forms must be assigned to the cancellation channel. If verification is incomplete, call paydirt_connect_slack to repair it.',
      'Report the files changed, build and launch commands and results, selected delivery route, enabled use cases, the setup check left open for immediate verification, any narrowly deferred cancellation automation, and an exact repeatable manual test path.',
      deliveryPreference === 'slack'
        ? 'Respect the Slack-only delivery choice. Do not offer or create a coding-agent daily brief unless the developer later enables coding-agent delivery.'
        : 'After every required delivery test passes, create the included daily brief with the current host\'s native scheduled-task capability and daily_brief.task_prompt. Confirm the 9:00 AM local schedule. If scheduling is unavailable, report that limitation and provide the prompt without claiming a schedule exists; this must not block Paydirt installation.',
    ],
    completion_requirements: {
      host_app_build_passed: true,
      host_app_launched: true,
      install_test_setup_visible: true,
      required_test_submissions: testForms.length,
      test_forms_not_submitted_by_agent: true,
      test_deliveries_verified: true,
      automatic_test_trigger_debug_only: true,
      delivery_preference_confirmed_during_onboarding: true,
      slack_channel_assignment_verified_when_selected: true,
      agent_response_access_read_only_when_selected: true,
      daily_brief_created_after_tests_when_host_supports_scheduling: deliveryPreference !== 'slack',
      daily_brief_limitation_reported_when_scheduling_is_unavailable: deliveryPreference !== 'slack',
    },
  };
}

function makeServer() {
  return new Server(
  {
    name: 'paydirt-mcp-server',
    version: PAYDIRT_MCP_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: `Paydirt is an agent-installed, voice-first iOS SDK for Suggest a Feature, named contextual forms, trial cancellation, and subscription cancellation, working with RevenueCat or StoreKit and connected to Slack. When the user says "add Paydirt," inspect the app first and use the explicitly requested form plan. An explicit request counts as confirmation; only ask a concise question when scope is unclear: recommend cancellation feedback after the real confirmed cancellation flow plus Suggest a Feature in Settings when subscriptions exist; otherwise explain that cancellation has no trigger and recommend Suggest a Feature. Call paydirt_begin_setup with form_plan_confirmed true and the requested use_cases. If the developer already started on the website, pass the supplied app_id to reconnect the exact app. Browser authorization reuses saved delivery settings and a healthy Slack connection. Browser onboarding signs the developer into Paydirt, creates or reuses the app and forms, and asks whether delivery should be Slack and coding agents (recommended), Slack only, or coding agents only. Coding-agent delivery includes a read-only daily 9:00 AM feedback brief created after verification when the host supports scheduling. When Slack is selected, onboarding runs Slack OAuth and lets the app owner choose their workspace and channels for the requested forms before releasing setup. Preserve every existing host-app feedback form, button, screen, handler, destination, purchase package, and subscription flow. Use RevenueCat when already installed; otherwise use native StoreKit for App Store subscriptions, including apps where Superwall only presents paywalls. Perform every returned agent_action: edit, resolve dependencies, build, launch, and leave the Debug setup check visibly open without submitting it. The developer personally submits each requested form; completion requires every requested delivery to be verified. Deliver only completed Q&A, never cancellation-only notices or drafts. Respect the saved delivery choice and repair Slack only when verification is incomplete. After testing, create the included read-only daily brief for coding-agent delivery when the host exposes real scheduling; otherwise report the limitation. Agent access is read-only; never inject every response into every session, create tasks, or change code automatically. Never wait, poll, or open a browser inside the MCP process.`,
  }
  );
}

const setupInputProperties = {
  app_id: {
    type: 'string',
    description: 'Existing Paydirt app ID, including the ID in a website setup handoff. Reconnect this exact app and reuse its saved Slack/delivery settings instead of creating another app.',
  },
  app_name: {
    type: 'string',
    description: 'Preferred app name to reuse or create during setup',
  },
  bundle_id: {
    type: 'string',
    description: 'Preferred iOS bundle ID to match during setup',
  },
  app_description: {
    type: 'string',
    description: 'Optional app description to save when creating or repairing setup',
  },
  use_cases: {
    type: 'array',
    items: {
      type: 'string',
      enum: ['regular_feedback', 'feature_request', 'trial_cancellation', 'subscription_cancellation'],
    },
    description: 'Confirmed feedback experiences to install. The recommended plan is Suggest a Feature plus trial and paid cancellation when subscriptions exist.',
  },
  form_plan_confirmed: {
    type: 'boolean',
    description: 'Set true when the developer explicitly requested these voice forms or confirmed the proposed plan. An explicit installation request already confirms its scope; do not ask the same question again. Ask only when the requested forms or placement are ambiguous.',
  },
  feature_placement: {
    type: 'string',
    description: 'Developer-confirmed placement for Suggest a Feature, such as settings or after_successful_export. Defaults to settings.',
  },
  uses_revenuecat: {
    type: 'boolean',
    description: 'Deprecated compatibility input. Prefer subscription_provider.',
  },
  subscription_provider: {
    type: 'string',
    enum: ['auto', 'none', 'storekit', 'revenuecat', 'superwall', 'custom'],
    description: 'Subscription source of truth discovered in the host app. Use auto only when it could not be resolved before setup.',
  },
  subscription_product_ids: {
    type: 'array',
    items: { type: 'string' },
    description: 'Native StoreKit auto-renewable product IDs. Required for a complete storekit integration.',
  },
} as const;

function setupRequestContext(args: Record<string, unknown> | undefined) {
  const useCases = requestedUseCases(args?.use_cases);
  const subscriptionProvider = normalizeSubscriptionProvider(
    args?.subscription_provider,
    args?.uses_revenuecat
  );
  const subscriptionProductIds = Array.isArray(args?.subscription_product_ids)
    ? args.subscription_product_ids.filter((value): value is string =>
        typeof value === 'string' && value.trim().length > 0
      )
    : [];
  const featurePlacement = typeof args?.feature_placement === 'string' && args.feature_placement.trim()
    ? args.feature_placement.trim()
    : 'settings';

  return { useCases, subscriptionProvider, subscriptionProductIds, featurePlacement };
}

function setupFinishArguments(
  sessionId: string,
  args: Record<string, unknown> | undefined
): Record<string, unknown> {
  const finishArguments: Record<string, unknown> = { session_id: sessionId };
  for (const key of Object.keys(setupInputProperties)) {
    if (args?.[key] !== undefined) finishArguments[key] = args[key];
  }
  return finishArguments;
}

async function beginSetup(args: Record<string, unknown> | undefined) {
  const { useCases, subscriptionProvider, featurePlacement } = setupRequestContext(args);

  if (args?.form_plan_confirmed !== true) {
    const hasSubscriptions = subscriptionProvider !== 'none';
    return {
      success: true,
      status: 'confirmation_required',
      message: hasSubscriptions
        ? `I found ${subscriptionProvider === 'auto' ? 'a subscription flow' : subscriptionProvider} and recommend three clear forms: Suggest a Feature in ${featurePlacement}, Trial Cancellation, and Subscription Cancellation. Add all three and show them working? You can move or remove any later.`
        : `I did not find a subscription flow, so cancellation feedback would not have a real trigger. Add Suggest a Feature in ${featurePlacement} and show it working? You can move it later.`,
      confirmation: {
        recommended: hasSubscriptions ? 'add_both' : 'suggest_feature_only',
        options: hasSubscriptions
          ? [
              { id: 'add_both', label: 'Add all three', use_cases: ['feature_request', 'trial_cancellation', 'subscription_cancellation'] },
              { id: 'cancellation_only', label: 'Add both cancellation forms', use_cases: ['trial_cancellation', 'subscription_cancellation'] },
              { id: 'customize', label: 'Customize', follow_up: 'Ask where Suggest a Feature should live: Settings, a detected successful-action trigger, or another location the developer describes.' },
            ]
          : [
              { id: 'suggest_feature_only', label: 'Add Suggest a Feature', use_cases: ['feature_request'] },
              { id: 'customize', label: 'Customize', follow_up: 'Ask whether another form is wanted and where it should appear.' },
            ],
        feature_placement: featurePlacement,
      },
      next_tool: 'paydirt_begin_setup',
      next_arguments: {
        ...args,
        form_plan_confirmed: true,
        use_cases: hasSubscriptions
          ? ['feature_request', 'trial_cancellation', 'subscription_cancellation']
          : ['feature_request'],
        feature_placement: featurePlacement,
      },
    };
  }

  const session = await api.startSetupSession();
  const setupParams = new URLSearchParams({ session: session.session_id });
  setupParams.set('required_forms', formTypesForUseCases(useCases).join(','));

  if (typeof args?.app_id === 'string' && args.app_id.trim()) {
    setupParams.set('app_id', args.app_id.trim());
  }

  if (typeof args?.app_name === 'string' && args.app_name.length > 0) {
    setupParams.set('app_name', args.app_name);
  }
  if (typeof args?.bundle_id === 'string' && args.bundle_id.length > 0) {
    setupParams.set('bundle_id', args.bundle_id);
  }
  if (typeof args?.app_description === 'string' && args.app_description.length > 0) {
    setupParams.set('app_description', args.app_description);
  }

  return {
    success: true,
    status: 'authorization_required',
    session_id: session.session_id,
    expires_in_seconds: session.expires_in,
    authorization_url: `https://www.paydirt.ai/setup?${setupParams.toString()}`,
    message: 'Open authorization_url for the user. The MCP server does not open a browser or block while authorization is pending.',
    next_tool: 'paydirt_finish_setup',
    finish_arguments: setupFinishArguments(session.session_id, args),
  };
}

async function finishAuthenticatedSetup(
  credentials: CredentialStore,
  args: Record<string, unknown> | undefined
) {
  const stored = credentials.get();
  if (!stored?.auth_token) throw new Error('OAuth account credentials are missing');
  if (typeof args?.app_id === 'string' && args.app_id.trim() && args.app_id.trim() !== stored.app_id) {
    throw new Error('This OAuth grant belongs to a different app. Reauthorize the requested app_id before installing.');
  }

  const { useCases, subscriptionProvider, subscriptionProductIds, featurePlacement } = setupRequestContext(args);

  if (args?.form_plan_confirmed !== true) {
    const hasSubscriptions = subscriptionProvider !== 'none';
    return {
      success: true,
      status: 'confirmation_required',
      message: hasSubscriptions
        ? `I found ${subscriptionProvider === 'auto' ? 'a subscription flow' : subscriptionProvider} and recommend three clear forms: Suggest a Feature in ${featurePlacement}, Trial Cancellation, and Subscription Cancellation. Add all three and show them working? You can move or remove any later.`
        : `I did not find a subscription flow, so cancellation feedback would not have a real trigger. Add Suggest a Feature in ${featurePlacement} and show it working? You can move it later.`,
      confirmation: {
        recommended: hasSubscriptions ? 'add_both' : 'suggest_feature_only',
        options: hasSubscriptions
          ? [
              { id: 'add_both', label: 'Add all three', use_cases: ['feature_request', 'trial_cancellation', 'subscription_cancellation'] },
              { id: 'cancellation_only', label: 'Add both cancellation forms', use_cases: ['trial_cancellation', 'subscription_cancellation'] },
              { id: 'customize', label: 'Customize', follow_up: 'Ask where Suggest a Feature should live: Settings, a detected successful-action trigger, or another location the developer describes.' },
            ]
          : [
              { id: 'suggest_feature_only', label: 'Add Suggest a Feature', use_cases: ['feature_request'] },
              { id: 'customize', label: 'Customize', follow_up: 'Ask whether another form is wanted and where it should appear.' },
            ],
        feature_placement: featurePlacement,
      },
      next_tool: 'paydirt_begin_setup',
      next_arguments: {
        ...args,
        form_plan_confirmed: true,
        use_cases: hasSubscriptions
          ? ['feature_request', 'trial_cancellation', 'subscription_cancellation']
          : ['feature_request'],
        feature_placement: featurePlacement,
      },
    };
  }

  const ready = await api.ensureReadySetup(stored.auth_token, {
    app_id: stored.app_id,
    app_name: typeof args?.app_name === 'string' ? args.app_name : undefined,
    bundle_id: typeof args?.bundle_id === 'string' ? args.bundle_id : undefined,
    app_description: typeof args?.app_description === 'string' ? args.app_description : undefined,
    required_forms: formTypesForUseCases(useCases),
  });
  if (ready.app.id !== stored.app_id) {
    throw new Error('Setup returned a different app from this OAuth grant. Reauthorize the requested app before installing.');
  }
  const missingFormTypes = formTypesForUseCases(useCases).filter(
    (type) => !ready.forms.some((form) => form.type === type)
  );
  if (missingFormTypes.length > 0) {
    throw new Error(`Setup reported ready without requested forms: ${missingFormTypes.join(', ')}. Repair this app’s setup before installing.`);
  }
  credentials.set({
    auth_token: stored.auth_token,
    app_id: ready.app.id,
    api_key: ready.app.api_key,
    source: stored.source,
  });
  const deliveryPreference: DeliveryPreference = ready.app.feedback_delivery_preference === 'both'
    || ready.app.feedback_delivery_preference === 'slack'
    || ready.app.feedback_delivery_preference === 'agents'
    ? ready.app.feedback_delivery_preference
    : 'agents';
  const slackStatus = deliveryPreference === 'agents'
    ? null
    : await api.getSlackStatus(stored.auth_token, ready.app.id);

  return {
    success: true,
    status: 'ready',
    message: 'Paydirt and its required forms are ready. Continue by performing every agent_action below in the host iOS repository.',
    action: ready.action,
    installation: installationContract(
      ready.app.api_key,
      ready.app.id,
      ready.forms,
      useCases,
      subscriptionProvider,
      subscriptionProductIds,
      featurePlacement,
      deliveryPreference,
      slackStatus
    ),
  };
}

async function finishSetup(
  credentials: CredentialStore,
  sessionId: string,
  args: Record<string, unknown> | undefined
) {
  if (!sessionId.trim()) throw new Error('session_id is required');
  const status = await api.getSetupStatus(sessionId);

  if (status.status === 'pending') {
    return {
      success: false,
      status: 'pending',
      session_id: sessionId,
      message: 'Authorization is still pending. Ask the user to finish authorization_url, then call paydirt_finish_setup again with the same arguments.',
      retry_tool: 'paydirt_finish_setup',
      retry_arguments: setupFinishArguments(sessionId, args),
    };
  }

  if (status.status === 'expired') {
    return {
      success: false,
      status: 'expired',
      session_id: sessionId,
      message: 'The setup session expired. Start a new session with paydirt_begin_setup.',
      next_tool: 'paydirt_begin_setup',
    };
  }

  if (!status.auth_token || !status.api_key || !status.app_id) {
    throw new Error('Setup reported ready without complete credentials');
  }

  if (typeof args?.app_id === 'string' && args.app_id.trim() && args.app_id.trim() !== status.app_id) {
    throw new Error('Authorization returned a different app. Resume setup with the requested app_id before installing.');
  }

  const { useCases, subscriptionProvider, subscriptionProductIds, featurePlacement } = setupRequestContext(args);
  const missingFormTypes = formTypesForUseCases(useCases).filter(
    (type) => !status.forms?.some((form) => form.type === type)
  );
  if (missingFormTypes.length > 0) {
    throw new Error(`Setup reported ready without requested forms: ${missingFormTypes.join(', ')}. Resume browser setup for this app before installing.`);
  }
  credentials.set({
    auth_token: status.auth_token,
    app_id: status.app_id,
    api_key: status.api_key,
  });
  const deliveryPreference = status.delivery_preference || 'agents';
  const slackStatus = deliveryPreference === 'agents'
    ? null
    : await api.getSlackStatus(status.auth_token, status.app_id);
  const contract = installationContract(
    status.api_key,
    status.app_id,
    status.forms || [],
    useCases,
    subscriptionProvider,
    subscriptionProductIds,
    featurePlacement,
    deliveryPreference,
    slackStatus
  );

  return {
    success: true,
    status: 'ready',
    message: 'Paydirt is authenticated and the requested forms are ready. Continue by performing every agent_action below in the host iOS repository.',
    action: status.action,
    installation: contract,
  };
}

// Tool definitions
const toolDefinitions = [
  {
    name: 'paydirt_setup',
    description: 'Use this when an older client expects the single setup tool. Without session_id it starts setup and immediately returns authorization_url plus finish arguments; with session_id it checks once and returns pending, expired, or the complete installation contract. It never opens a browser or blocks. New agents should prefer paydirt_begin_setup and paydirt_finish_setup.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...setupInputProperties,
        session_id: {
          type: 'string',
          description: 'Setup session returned by the first call. When present, this call behaves like paydirt_finish_setup.',
        },
      },
      required: [],
    },
  },
  {
    name: 'paydirt_begin_setup',
    description: 'Use this when installing voice cancellation feedback or Suggest a Feature for an iOS app with RevenueCat or StoreKit, and connect Slack during browser authorization. For website-started setup, pass its app_id to reuse the prepared app and delivery settings. Inspect the host first. Without form_plan_confirmed, returns the concise cancellation/Suggest a Feature confirmation and does not start authorization. After confirmation, pass the selected use_cases and placement to receive authorization_url and finish_arguments immediately.',
    inputSchema: {
      type: 'object' as const,
      properties: setupInputProperties,
      required: [],
    },
  },
  {
    name: 'paydirt_finish_setup',
    description: 'Use this when the user has opened the authorization URL returned by paydirt_begin_setup. Checks one setup session and returns immediately. If pending, do not loop or sleep. When ready, securely saves credentials and returns the host-app build, visible verification, and post-verification delivery-choice contract.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: {
          type: 'string',
          description: 'The session_id returned by paydirt_begin_setup.',
        },
        ...setupInputProperties,
      },
      required: ['session_id'],
    },
  },
  {
    name: 'paydirt_list_apps',
    description: 'Use this when the user asks which Paydirt apps exist or when an agent must resolve an app ID after setup. Lists all apps for the authenticated Paydirt account without changing them.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'paydirt_create_app',
    description: 'Use this when the user explicitly needs a separate Paydirt app and setup cannot reuse or create it. Creates a new app; list existing apps first when duplication is possible.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Name of the app',
        },
        bundle_id: {
          type: 'string',
          description: 'iOS bundle ID (optional)',
        },
        app_description: {
          type: 'string',
          description: 'Description of the app (optional)',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'paydirt_get_app',
    description: 'Use this when the agent needs the current identity, bundle ID, SDK key, or configuration for one known Paydirt app. Does not modify the app.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description: 'The app ID',
        },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'paydirt_list_forms',
    description: 'Use this when the user asks which forms exist or the agent needs to resolve or deduplicate forms for a Paydirt app. Does not modify forms.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description: 'The app ID',
        },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'paydirt_create_form',
    description: 'Use this when creating a low-level remote form without a host-app placement request. First confirm a matching form does not exist. Map subscription cancellation to cancellation, trial cancellation to trial_expiration, and regular feedback to custom; then wire the returned ID into iOS and assign Slack. Prefer paydirt_add_feedback_form for named screen or action placement.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description: 'The app ID',
        },
        name: {
          type: 'string',
          description: 'Name of the form',
        },
        type: {
          type: 'string',
          enum: ['cancellation', 'trial_expiration', 'feature_request', 'custom'],
          description: 'Type of form',
        },
        prompt: {
          type: 'string',
          description: 'Initial prompt/question for the form',
        },
        custom_system_prompt: {
          type: 'string',
          description: 'Custom system prompt for AI (optional)',
        },
      },
      required: ['app_id', 'name', 'type', 'prompt'],
    },
  },
  {
    name: 'paydirt_add_feedback_form',
    description: 'Use this when the user asks for a named feedback form at a screen, button, lifecycle moment, or in-app action. Creates or reuses a normalized-title match, preserves the placement verbatim, optionally resolves Slack, and returns exact Swift plus mandatory edit/build/test actions. Remote form creation alone is not completion.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description: 'The Paydirt app ID. Discover it with setup or list_apps rather than asking if it is already available.',
        },
        title: {
          type: 'string',
          description: 'The exact user-requested form title, such as “Post Export Feedback”.',
        },
        placement: {
          type: 'string',
          description: 'The exact host-app location or action from the user, such as “Settings below Restore Purchases” or “after a successful export”. Preserve this text through implementation and reporting.',
        },
        trigger: {
          type: 'string',
          enum: ['user_tap', 'in_app_action', 'screen_appearance', 'custom_condition'],
          description: 'How presentation is triggered. Use user_tap for a button/menu item, in_app_action after an action succeeds, screen_appearance when opening a screen, or custom_condition for app-specific logic.',
        },
        initial_question: {
          type: 'string',
          description: 'Optional first question. Defaults to “What would you like us to know?”. If supplied on a retry, the existing matching form is updated instead of duplicated.',
        },
        custom_system_prompt: {
          type: 'string',
          description: 'Optional guidance for AI follow-up questions.',
        },
        slack_channel: {
          type: 'string',
          description: 'Optional Slack channel name (with or without #) or channel ID when the developer already selected Slack delivery. If omitted, Slack is deferred until after visual verification.',
        },
      },
      required: ['app_id', 'title', 'placement', 'trigger'],
    },
  },
  {
    name: 'paydirt_get_responses',
    description: 'Use this when the user or coding agent needs raw feedback conversations, exact Q/A turns, input type, subscription metadata, or a read-only inbox cursor. Defaults to completed conversations. Use since plus the newest updated_at for incremental reads; never take action from responses automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description: 'The app ID',
        },
        form_id: {
          type: 'string',
          description: 'Filter by form ID (optional)',
        },
        status: {
          type: 'string',
          enum: ['completed', 'in_progress', 'abandoned', 'all'],
          description: 'Conversation status filter (default: completed)',
        },
        since: {
          type: 'string',
          description: 'Only return responses created at or after this ISO-8601 timestamp',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'Maximum responses to return (default: 50)',
        },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'paydirt_get_summary',
    description: 'Use this when the user asks for an aggregate AI summary of recent Paydirt responses. Raw questions and answers remain the source of truth; this read-only summary is supplementary.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description: 'The app ID',
        },
        form_id: {
          type: 'string',
          description: 'Filter by form ID (optional)',
        },
        days: {
          type: 'number',
          description: 'Number of days to include (default: 7)',
        },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'paydirt_get_feedback_digest',
    description: 'Use this when the user or a scheduled task needs a read-only daily or periodic Paydirt brief. Returns completed-response totals by feedback type, comparison with the previous equal period, and concise highlights. Never turn feedback into code changes or tasks automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description: 'The Paydirt app ID',
        },
        hours: {
          type: 'number',
          minimum: 1,
          maximum: 168,
          description: 'Period length in hours (default: 24). The comparison uses the immediately preceding period of equal length.',
        },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'paydirt_connect_slack',
    description: 'Use this when the user asks to connect Slack or repair Slack delivery after onboarding. Returns the Slack OAuth URL for the app owner’s workspace. Browser onboarding lets the owner select channels; preserve those choices and verify every requested form assignment. Only completed Q&A is sent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description: 'The app ID',
        },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'paydirt_list_slack_channels',
    description: 'Use this when Slack is connected and the agent must resolve a requested channel name to its channel ID. Lists available channels without changing assignments.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description: 'The app ID',
        },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'paydirt_set_form_channel',
    description: 'Use this when a form must deliver completed conversations to a specific Slack channel ID. Replaces that form’s current channel assignment and should be verified afterward.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description: 'The app ID',
        },
        form_id: {
          type: 'string',
          description: 'The form ID',
        },
        channel_id: {
          type: 'string',
          description: 'The Slack channel ID',
        },
      },
      required: ['app_id', 'form_id', 'channel_id'],
    },
  },
  {
    name: 'paydirt_update_form',
    description: 'Use this when the user asks to change an existing form’s name, initial question, or AI follow-up guidance. Only supplied fields are updated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        form_id: {
          type: 'string',
          description: 'The form ID',
        },
        name: {
          type: 'string',
          description: 'New name for the form (optional)',
        },
        prompt: {
          type: 'string',
          description: 'New prompt/question for the form (optional)',
        },
        custom_system_prompt: {
          type: 'string',
          description: 'New custom system prompt for AI (optional)',
        },
      },
      required: ['form_id'],
    },
  },
  // New tools
  {
    name: 'paydirt_health_check',
    description: 'Use this when diagnosing whether the Paydirt API is reachable and stored authentication is valid. Performs a read-only connectivity check.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'paydirt_update_app',
    description: 'Use this when the user asks to change an existing Paydirt app’s identity, bundle ID, description, or AI context. Only supplied fields are updated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description: 'The app ID',
        },
        name: {
          type: 'string',
          description: 'New name for the app (optional)',
        },
        bundle_id: {
          type: 'string',
          description: 'iOS bundle ID (optional)',
        },
        app_description: {
          type: 'string',
          description: 'Description of the app (optional)',
        },
        system_prompt: {
          type: 'string',
          description: 'Custom system prompt for AI responses (optional)',
        },
        app_context_prompt: {
          type: 'string',
          description: 'Context about the app for AI (optional)',
        },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'paydirt_get_form',
    description: 'Use this when the agent needs the current prompt, type, enabled state, or Slack assignment for one known form. Does not modify the form.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        form_id: {
          type: 'string',
          description: 'The form ID',
        },
      },
      required: ['form_id'],
    },
  },
  {
    name: 'paydirt_delete_form',
    description: 'Use this when the user explicitly asks to permanently delete a specific Paydirt form. This is destructive and should only be called after inspecting the form when its identity is uncertain.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        form_id: {
          type: 'string',
          description: 'The form ID to delete',
        },
      },
      required: ['form_id'],
    },
  },
  {
    name: 'paydirt_slack_status',
    description: 'Use this when the developer selected Slack or combined delivery and completed authorization. Reports the Paydirt feedback channel and whether every installed form is assigned. Do not call it for agent-only delivery.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description: 'The app ID',
        },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'paydirt_toggle_form',
    description: 'Use this when the user asks to enable or disable an existing form remotely. Disabled forms are not shown by the SDK; calling again with the opposite value reverses the change.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        form_id: {
          type: 'string',
          description: 'The form ID',
        },
        enabled: {
          type: 'boolean',
          description: 'Whether the form should be enabled (true) or disabled (false)',
        },
      },
      required: ['form_id', 'enabled'],
    },
  },
  {
    name: 'paydirt_ask',
    description: 'Use this when the user asks a natural-language analytical question about their Paydirt feedback, such as pricing themes or feature requests. Reads actual responses and returns analysis without taking action.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description: 'The app ID',
        },
        question: {
          type: 'string',
          description: 'Your question about the feedback (e.g., "What are users saying about pricing?" or "What features are most requested?")',
        },
        form_id: {
          type: 'string',
          description: 'Filter to a specific form (optional)',
        },
        days: {
          type: 'number',
          description: 'Number of days of data to analyze (default: 30)',
        },
      },
      required: ['app_id', 'question'],
    },
  },
];

interface PaydirtToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const toolAnnotations: Record<string, PaydirtToolAnnotations> = {
  paydirt_setup: {
    title: 'Set Up Paydirt (Compatibility)', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
  },
  paydirt_begin_setup: {
    title: 'Begin Paydirt Setup', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
  },
  paydirt_finish_setup: {
    title: 'Finish Paydirt Setup', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  paydirt_list_apps: {
    title: 'List Paydirt Apps', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  paydirt_create_app: {
    title: 'Create Paydirt App', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
  },
  paydirt_get_app: {
    title: 'Get Paydirt App', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  paydirt_list_forms: {
    title: 'List Feedback Forms', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  paydirt_create_form: {
    title: 'Create Feedback Form', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
  },
  paydirt_add_feedback_form: {
    title: 'Add Form at App Placement', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  },
  paydirt_get_responses: {
    title: 'Get Raw Feedback Responses', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  paydirt_get_summary: {
    title: 'Summarize Feedback', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  paydirt_get_feedback_digest: {
    title: 'Get Feedback Digest', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  paydirt_connect_slack: {
    title: 'Connect Slack', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  paydirt_list_slack_channels: {
    title: 'List Slack Channels', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  paydirt_set_form_channel: {
    title: 'Assign Form to Slack Channel', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  },
  paydirt_update_form: {
    title: 'Update Feedback Form', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  },
  paydirt_health_check: {
    title: 'Check Paydirt Health', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  paydirt_update_app: {
    title: 'Update Paydirt App', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  },
  paydirt_get_form: {
    title: 'Get Feedback Form', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  paydirt_delete_form: {
    title: 'Delete Feedback Form', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  },
  paydirt_slack_status: {
    title: 'Check Slack Connection', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
  paydirt_toggle_form: {
    title: 'Enable or Disable Form', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  },
  paydirt_ask: {
    title: 'Ask About Feedback', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  },
};

const setupOutputSchema = {
  type: 'object' as const,
  properties: {
    success: { type: 'boolean' },
    status: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['success', 'status'],
};

const appOutputSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    bundle_id: { type: ['string', 'null'] },
    api_key: { type: 'string' },
  },
  required: ['id', 'name', 'api_key'],
};

const formProperties = {
  id: { type: 'string' },
  app_id: { type: 'string' },
  name: { type: 'string' },
  type: { type: 'string' },
  prompt: { type: 'string' },
  slack_channel_id: { type: ['string', 'null'] },
  enabled: { type: 'boolean' },
};

const directFormOutputSchema = {
  type: 'object' as const,
  properties: formProperties,
  required: ['id', 'app_id', 'name', 'type', 'prompt'],
};

const wrappedFormOutputSchema = {
  type: 'object' as const,
  properties: {
    form: directFormOutputSchema,
  },
  required: ['form'],
};

const toolOutputSchemas: Record<string, { type: 'object'; properties?: Record<string, object>; required?: string[] }> = {
  paydirt_setup: setupOutputSchema,
  paydirt_begin_setup: setupOutputSchema,
  paydirt_finish_setup: setupOutputSchema,
  paydirt_create_app: appOutputSchema,
  paydirt_get_app: appOutputSchema,
  paydirt_create_form: directFormOutputSchema,
  paydirt_add_feedback_form: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      form_action: { type: 'string', enum: ['created', 'reused', 'reused_and_updated'] },
      form: { type: 'object' },
      requested_placement: { type: 'object' },
      ios: { type: 'object' },
      slack: { type: 'object' },
      agent_actions: { type: 'array', items: { type: 'string' } },
      completion_requirements: { type: 'object' },
    },
    required: ['success', 'form_action', 'form', 'requested_placement', 'ios', 'slack', 'agent_actions', 'completion_requirements'],
  },
  paydirt_get_summary: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      top_reasons: { type: 'array', items: { type: 'string' } },
      response_count: { type: 'number' },
      period: { type: 'string' },
    },
    required: ['summary', 'top_reasons', 'response_count', 'period'],
  },
  paydirt_get_feedback_digest: {
    type: 'object',
    properties: {
      app_id: { type: 'string' },
      period: { type: 'object' },
      counts: { type: 'object' },
      previous_period_total: { type: 'number' },
      change_from_previous_period: { type: 'number' },
      truncated: { type: 'boolean' },
      items: { type: 'array', items: { type: 'object' } },
    },
    required: ['app_id', 'period', 'counts', 'previous_period_total', 'change_from_previous_period', 'truncated', 'items'],
  },
  paydirt_connect_slack: {
    type: 'object', properties: { auth_url: { type: 'string' } }, required: ['auth_url'],
  },
  paydirt_list_slack_channels: {
    type: 'object',
    properties: {
      channels: { type: 'array', items: { type: 'object' } },
      team_name: { type: 'string' },
    },
    required: ['channels', 'team_name'],
  },
  paydirt_set_form_channel: wrappedFormOutputSchema,
  paydirt_update_form: wrappedFormOutputSchema,
  paydirt_health_check: {
    type: 'object',
    properties: { status: { type: 'string' }, authenticated: { type: 'boolean' } },
    required: ['status', 'authenticated'],
  },
  paydirt_update_app: appOutputSchema,
  paydirt_get_form: wrappedFormOutputSchema,
  paydirt_delete_form: {
    type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'],
  },
  paydirt_slack_status: {
    type: 'object',
    properties: { connected: { type: 'boolean' }, team_name: { type: ['string', 'null'] } },
    required: ['connected', 'team_name'],
  },
  paydirt_toggle_form: wrappedFormOutputSchema,
  paydirt_ask: {
    type: 'object',
    properties: {
      answer: { type: 'string' }, response_count: { type: 'number' }, days: { type: 'number' },
    },
    required: ['answer', 'response_count', 'days'],
  },
};

const tools = toolDefinitions.map((tool) => {
  const annotations = toolAnnotations[tool.name];
  if (!annotations) throw new Error(`Missing MCP annotations for ${tool.name}`);
  const outputSchema = toolOutputSchemas[tool.name];
  return {
    ...tool,
    annotations,
    ...(outputSchema ? { outputSchema } : {}),
  };
});

function successfulToolResult(name: string, result: unknown) {
  const content = [
    {
      type: 'text' as const,
      text: JSON.stringify(result, null, 2),
    },
  ];
  if (toolOutputSchemas[name] && result !== null && typeof result === 'object' && !Array.isArray(result)) {
    return { content, structuredContent: result as Record<string, unknown> };
  }
  return { content };
}

// Handle list tools request
export function createPaydirtServer(credentials: CredentialStore): Server {
  const server = makeServer();

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Setup tools do not require auth. They return immediately and never launch a browser or poll.
  if (name === 'paydirt_setup' || name === 'paydirt_begin_setup' || name === 'paydirt_finish_setup') {
    try {
      const sessionId = typeof args?.session_id === 'string' ? args.session_id : '';
      const result = sessionId
        ? await finishSetup(credentials, sessionId, args)
        : credentials.get()?.source === 'hosted_oauth'
          ? await finishAuthenticatedSetup(credentials, args)
          : name === 'paydirt_finish_setup'
            ? (() => { throw new Error('session_id is required'); })()
            : await beginSetup(args);
      return successfulToolResult(name, result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return successfulToolResult(name, {
        success: false,
        status: 'error',
        message: `Setup error: ${errorMessage}`,
      });
    }
  }

  // All other tools require authentication
  const AUTH_TOKEN = credentials.get()?.auth_token || '';
  if (!AUTH_TOKEN) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Not authenticated. Run paydirt_begin_setup, have the user open authorization_url, then run paydirt_finish_setup.',
        },
      ],
    };
  }

  try {
    let result: unknown;

    switch (name) {
      case 'paydirt_list_apps':
        result = await api.listApps(AUTH_TOKEN);
        break;

      case 'paydirt_create_app':
        result = await api.createApp(AUTH_TOKEN, {
          name: args?.name as string,
          bundle_id: args?.bundle_id as string | undefined,
          app_description: args?.app_description as string | undefined,
        });
        break;

      case 'paydirt_get_app':
        result = await api.getApp(AUTH_TOKEN, args?.app_id as string);
        break;

      case 'paydirt_list_forms':
        result = await api.listForms(AUTH_TOKEN, args?.app_id as string);
        break;

      case 'paydirt_create_form':
        result = await api.createForm(AUTH_TOKEN, args?.app_id as string, {
          name: args?.name as string,
          type: args?.type as string,
          prompt: args?.prompt as string,
          custom_system_prompt: args?.custom_system_prompt as string | undefined,
        });
        break;

      case 'paydirt_add_feedback_form': {
        const appId = args?.app_id as string;
        const title = typeof args?.title === 'string' ? args.title.trim() : '';
        const placement = typeof args?.placement === 'string' ? args.placement.trim() : '';
        const trigger = args?.trigger as FeedbackTrigger;
        const validTriggers: FeedbackTrigger[] = [
          'user_tap',
          'in_app_action',
          'screen_appearance',
          'custom_condition',
        ];

        if (!appId || !title || !placement || !validTriggers.includes(trigger)) {
          throw new Error('app_id, a non-empty title and placement, and a valid trigger are required');
        }

        const requestedQuestion = typeof args?.initial_question === 'string'
          ? args.initial_question.trim()
          : undefined;
        const customSystemPrompt = typeof args?.custom_system_prompt === 'string'
          ? args.custom_system_prompt.trim()
          : undefined;

        const existingForms = await api.listForms(AUTH_TOKEN, appId);
        let form = findCustomFormByName(existingForms, title);
        let formAction: 'created' | 'reused' | 'reused_and_updated' = 'reused';

        if (!form) {
          form = await api.createForm(AUTH_TOKEN, appId, {
            name: title,
            type: 'custom',
            prompt: requestedQuestion || 'What would you like us to know?',
            custom_system_prompt: customSystemPrompt,
          });
          formAction = 'created';
        } else if (
          (requestedQuestion && requestedQuestion !== form.prompt)
          || (customSystemPrompt && customSystemPrompt !== form.custom_system_prompt)
        ) {
          const updated = await api.updateForm(AUTH_TOKEN, form.id, {
            prompt: requestedQuestion || form.prompt,
            custom_system_prompt: customSystemPrompt || form.custom_system_prompt || undefined,
          });
          form = updated.form;
          formAction = 'reused_and_updated';
        }

        const requestedSlackChannel = typeof args?.slack_channel === 'string'
          ? args.slack_channel.trim()
          : '';
        let slack: Record<string, unknown>;

        if (form.slack_channel_id && !requestedSlackChannel) {
          slack = {
            status: 'assigned',
            channel_id: form.slack_channel_id,
            verified: true,
          };
        } else if (!requestedSlackChannel) {
          slack = {
            status: 'deferred',
            required: false,
            verified: false,
            next_action: 'Build and show the form first. Then ask whether delivery should be Slack and coding agents (recommended), Slack only, or coding agents only. Connect Slack only when selected.',
          };
        } else {
          const slackStatus = await api.getSlackStatus(AUTH_TOKEN, appId);
          if (!slackStatus.connected) {
            const install = await api.getSlackInstallUrl(AUTH_TOKEN, appId);
            slack = {
              status: 'connection_required',
              verified: false,
              auth_url: install.auth_url,
              next_action: 'Open auth_url, let the user authorize Slack, then call this tool again with the same title and placement. The form will be reused.',
            };
          } else if (!requestedSlackChannel) {
            slack = {
              status: 'channel_required',
              workspace: slackStatus.team_name,
              verified: false,
              next_tools: ['paydirt_list_slack_channels', 'paydirt_set_form_channel'],
            };
          } else {
            const available = await api.listSlackChannels(AUTH_TOKEN, appId);
            const normalizedChannel = requestedSlackChannel.replace(/^#/, '').toLocaleLowerCase();
            const channel = available.channels.find((candidate) =>
              candidate.id === requestedSlackChannel
              || candidate.name.toLocaleLowerCase() === normalizedChannel
            );

            if (!channel) {
              slack = {
                status: 'channel_not_found',
                workspace: available.team_name,
                requested_channel: requestedSlackChannel,
                verified: false,
                available_channels: available.channels.map((candidate) => ({
                  id: candidate.id,
                  name: candidate.name,
                })),
              };
            } else {
              const assigned = await api.setFormSlackChannel(AUTH_TOKEN, appId, form.id, channel.id);
              form = assigned.form;
              slack = {
                status: 'assigned',
                workspace: available.team_name,
                channel_id: channel.id,
                channel_name: channel.name,
                verified: assigned.form.slack_channel_id === channel.id,
              };
            }
          }
        }

        result = feedbackPlacementContract(form, placement, trigger, formAction, slack);
        break;
      }

      case 'paydirt_get_responses':
        result = await api.getResponses(
          AUTH_TOKEN,
          args?.app_id as string,
          {
            formId: args?.form_id as string | undefined,
            status: args?.status as 'completed' | 'in_progress' | 'abandoned' | 'all' | undefined,
            since: args?.since as string | undefined,
            limit: args?.limit as number | undefined,
          }
        );
        break;

      case 'paydirt_get_summary':
        result = await api.getSummary(
          AUTH_TOKEN,
          args?.app_id as string,
          args?.form_id as string | undefined,
          args?.days as number | undefined
        );
        break;

      case 'paydirt_get_feedback_digest':
        result = await api.getFeedbackDigest(
          AUTH_TOKEN,
          args?.app_id as string,
          args?.hours as number | undefined
        );
        break;

      case 'paydirt_connect_slack':
        result = await api.getSlackInstallUrl(AUTH_TOKEN, args?.app_id as string);
        break;

      case 'paydirt_list_slack_channels':
        result = await api.listSlackChannels(AUTH_TOKEN, args?.app_id as string);
        break;

      case 'paydirt_set_form_channel':
        result = await api.setFormSlackChannel(
          AUTH_TOKEN,
          args?.app_id as string,
          args?.form_id as string,
          args?.channel_id as string
        );
        break;

      case 'paydirt_update_form':
        result = await api.updateForm(
          AUTH_TOKEN,
          args?.form_id as string,
          {
            name: args?.name as string | undefined,
            prompt: args?.prompt as string | undefined,
            custom_system_prompt: args?.custom_system_prompt as string | undefined,
          }
        );
        break;

      // New tool handlers
      case 'paydirt_health_check':
        result = await api.healthCheck(AUTH_TOKEN);
        break;

      case 'paydirt_update_app':
        result = await api.updateApp(AUTH_TOKEN, args?.app_id as string, {
          name: args?.name as string | undefined,
          bundle_id: args?.bundle_id as string | undefined,
          app_description: args?.app_description as string | undefined,
          system_prompt: args?.system_prompt as string | undefined,
          app_context_prompt: args?.app_context_prompt as string | undefined,
        });
        break;

      case 'paydirt_get_form':
        result = await api.getForm(AUTH_TOKEN, args?.form_id as string);
        break;

      case 'paydirt_delete_form':
        result = await api.deleteForm(AUTH_TOKEN, args?.form_id as string);
        break;

      case 'paydirt_slack_status':
        result = await api.getSlackStatus(AUTH_TOKEN, args?.app_id as string);
        break;

      case 'paydirt_toggle_form':
        result = await api.toggleForm(
          AUTH_TOKEN,
          args?.form_id as string,
          args?.enabled as boolean
        );
        break;

      case 'paydirt_ask':
        result = await api.askQuestion(
          AUTH_TOKEN,
          args?.app_id as string,
          args?.question as string,
          args?.form_id as string | undefined,
          args?.days as number | undefined
        );
        break;

      default:
        return {
          content: [
            {
              type: 'text' as const,
              text: `Unknown tool: ${name}`,
            },
          ],
        };
    }

    return successfulToolResult(name, result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: ${errorMessage}`,
        },
      ],
    };
  }
  });

  return server;
}
