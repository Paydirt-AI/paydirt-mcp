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
  /** The app this session works with: the grant's app, or the app returned by setup. */
  app_id?: string;
  /** Set only when a hosted OAuth grant is bound to one app. User-scoped grants leave it empty. */
  grant_app_id?: string;
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

type DeliveryDestination = 'slack' | 'codex' | 'claude-code';
const DELIVERY_DESTINATIONS: DeliveryDestination[] = ['slack', 'codex', 'claude-code'];

export const DELIVERY_QUESTION = 'Where should responses go: Slack, here in your coding agent, or both? Both is recommended.';

/** Maps the destinations the developer chose in chat to the app's feedback_delivery_preference. */
export function deliveryPreferenceForDestinations(value: unknown): DeliveryPreference {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`destinations must list one or more of: ${DELIVERY_DESTINATIONS.join(', ')}`);
  }
  const invalid = value.filter((item) => !DELIVERY_DESTINATIONS.includes(item as DeliveryDestination));
  if (invalid.length > 0) {
    throw new Error(`Unknown destination ${JSON.stringify(invalid[0])}. Use ${DELIVERY_DESTINATIONS.join(', ')}.`);
  }
  const slack = value.includes('slack');
  const agent = value.includes('codex') || value.includes('claude-code');
  if (slack && agent) return 'both';
  return slack ? 'slack' : 'agents';
}

function configuredPreference(value: unknown): DeliveryPreference | null {
  return value === 'both' || value === 'slack' || value === 'agents' ? value : null;
}

function deliverySelectionRequired(appId: string, retryTool: string, retryArguments: Record<string, unknown>) {
  return {
    success: true,
    status: 'delivery_selection_required',
    app_id: appId,
    message: 'Paydirt created the app and forms, but no delivery destination is saved. Ask the developer the question below exactly, call paydirt_set_delivery with their answer, then call retry_tool again with retry_arguments. Do not assume a destination.',
    question: DELIVERY_QUESTION,
    options: [
      { id: 'both', label: 'Both (recommended)', destinations: ['slack', 'claude-code'] },
      { id: 'slack', label: 'Slack', destinations: ['slack'] },
      { id: 'agents', label: 'Here in the coding agent', destinations: ['claude-code'] },
    ],
    destination_note: "Use 'codex' instead of 'claude-code' when running in Codex.",
    next_tool: 'paydirt_set_delivery',
    next_arguments: { app_id: appId },
    retry_tool: retryTool,
    retry_arguments: retryArguments,
  };
}

const WAIT_DEFAULT_SECONDS = 45; // under the 60s default request timeout most MCP clients use
const WAIT_MAX_SECONDS = 90;
const WAIT_POLL_MS = 3_000;
const WAIT_DEFAULT_LOOKBACK_MS = 2 * 60 * 1_000;

export interface WaitDependencies {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
  signal?: AbortSignal;
  onPoll?: (elapsedMs: number, totalMs: number) => void;
}

const realWaitDependencies: WaitDependencies = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs: WAIT_POLL_MS,
};

const ISO_DATE_TIME = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?(Z|[+-]\d{2}:?\d{2})?$/i;

/** Reads since as ISO-8601; a date-time without Z or an offset is UTC, never the server's local time. */
function parseSince(value: unknown): number {
  const match = typeof value === 'string' ? ISO_DATE_TIME.exec(value.trim()) : null;
  const iso = match ? `${match[1]}${match[2] ? `T${match[2]}${match[3] || 'Z'}` : ''}` : '';
  const time = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(time)) {
    throw new Error('since must be an ISO-8601 date-time such as 2026-10-11T12:00:00Z (times without Z or an offset are read as UTC)');
  }
  return time;
}

/**
 * The one bounded wait Paydirt allows: poll completed responses every 3s for at
 * most 90s so the agent can announce the developer's first test answer.
 */
export async function waitForResponse(
  token: string,
  args: { app_id: string; since?: unknown; form_id?: unknown; timeout_seconds?: unknown },
  dependencies: WaitDependencies = realWaitDependencies
) {
  const startedAt = dependencies.now();
  const sinceTime = args.since === undefined || args.since === null
    ? startedAt - WAIT_DEFAULT_LOOKBACK_MS
    : parseSince(args.since);
  // A future since would never match, so it never starts later than now.
  const since = new Date(Math.min(sinceTime, startedAt)).toISOString();
  const requested = typeof args.timeout_seconds === 'number' && Number.isFinite(args.timeout_seconds)
    ? args.timeout_seconds
    : WAIT_DEFAULT_SECONDS;
  const timeoutSeconds = Math.min(WAIT_MAX_SECONDS, Math.max(1, Math.round(requested)));
  const deadline = startedAt + timeoutSeconds * 1_000;
  const formId = typeof args.form_id === 'string' && args.form_id ? args.form_id : undefined;

  for (;;) {
    const responses = await api.getCompletedResponsesSince(token, args.app_id, { since, formId });
    const response = responses[0];
    if (response) {
      const answer = [...(response.conversation || [])]
        .reverse()
        .find((message) => message.role === 'user' && message.content?.trim())?.content.trim();
      return {
        status: 'received' as const,
        app_id: args.app_id,
        since,
        received_count: responses.length,
        response: {
          id: response.id,
          form_id: response.form_id,
          form_name: response.forms?.name ?? null,
          form_type: response.forms?.type ?? null,
          answer: answer ?? null,
          conversation: response.conversation,
          completed_at: response.completed_at,
          created_at: response.created_at,
        },
        announce: answer
          ? `Your first response just landed: "${answer}"`
          : 'Your first response just landed.',
      };
    }
    const now = dependencies.now();
    if (dependencies.signal?.aborted || now + dependencies.pollIntervalMs > deadline) {
      return {
        status: 'timed_out' as const,
        app_id: args.app_id,
        since,
        waited_seconds: Math.round((now - startedAt) / 1_000),
        next: 'ask the human whether they submitted; call again',
        retry_arguments: { app_id: args.app_id, since, ...(formId ? { form_id: formId } : {}) },
      };
    }
    dependencies.onPoll?.(now - startedAt, deadline - startedAt);
    await dependencies.sleep(dependencies.pollIntervalMs);
  }
}

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
        opens_automatically_on_first_launch: true,
        behavior: `Add the DEBUG-only one-time app-ready trigger so the setup check opens automatically on first launch with no navigation, then build and launch on a simulator or connected device and leave it open. The developer personally submits each requested test. Completion means ${testForms.length}/${testForms.length} ${requiresSlackDelivery ? 'delivered to their selected Slack channels' : 'received by Paydirt'}. Never submit a test for them or include the trigger in release builds. Form delivery verification does not prove the real subscription cancellation trigger; verify each requested trial/paid trigger separately with the host subscription provider.`,
      } : null,
    },
    delivery: {
      selected: deliveryPreference,
      recommended: 'both',
      prompt: 'The developer chose this destination in chat. Do not ask again unless they ask to change it; use paydirt_set_delivery for a change.',
      options: [
        {
          id: 'both',
          label: 'Slack and coding agents',
          destinations: ['slack', 'claude-code'],
          recommended: true,
          behavior: 'Connect Slack in parallel with the build, route every installed form, and keep read-only response access available through Paydirt agent tools.',
        },
        {
          id: 'slack',
          label: 'Slack only',
          destinations: ['slack'],
          recommended: false,
          behavior: 'Connect Slack in parallel with the build and route every installed form. Do not proactively surface feedback in agent sessions.',
        },
        {
          id: 'agents',
          label: 'Coding agents only',
          destinations: ['claude-code'],
          recommended: false,
          behavior: 'Keep responses available through read-only Paydirt agent tools. Do not start Slack authorization.',
        },
      ],
      agent_sessions: {
        available_after_setup: true,
        read_only: true,
        rule: 'Do not inject every response into every session and never create tasks or change code automatically. Surface a new-response count or fetch raw responses only when the developer asks.',
      },
    },
    slack: {
      required_for_setup: requiresSlackDelivery,
      connected: Boolean(slackStatus?.connected),
      feature_channel: slackStatus ? {
        id: slackStatus.feature_channel_id,
        name: slackStatus.feature_channel_name,
        assignment: slackStatus.assignments?.feature ?? null,
      } : null,
      cancellation_channel: slackStatus ? {
        id: slackStatus.cancellation_channel_id,
        name: slackStatus.cancellation_channel_name,
        assignment: slackStatus.assignments?.cancellation ?? null,
      } : null,
      all_forms_assigned: slackStatus?.all_forms_assigned ?? false,
      two_channel_routing: slackStatus?.two_channel_routing ?? false,
      connect_when_selected: ['both', 'slack'],
      next_tools: ['paydirt_connect_slack', 'paydirt_list_slack_channels', 'paydirt_set_slack_channels', 'paydirt_slack_status'],
      rule: requiresSlackDelivery
        ? 'Start Slack OAuth right after confirmation, in parallel with the build; never wait on it. Pick channels in chat after launch. Deliver only completed Q&A, never cancellation-only events or drafts.'
        : 'Slack was not chosen. Do not start Slack OAuth unless the developer asks to change delivery.',
    },
    daily_brief: {
      included_with_coding_agent_delivery: deliveryPreference !== 'slack',
      eligible: deliveryPreference !== 'slack',
      offer_after_first_response: deliveryPreference !== 'slack',
      recommended_schedule: 'Every day at 9:00 AM in the developer\'s local timezone',
      selection_disclosure: 'Coding-agent delivery includes an optional read-only daily brief. Offer it; create it only when the developer accepts. They can pause, edit, or delete it in the host scheduling UI.',
      task_prompt: `Check Paydirt app ${appId} for the last 24 hours using paydirt_get_feedback_digest. Report total new completed feedback, Suggest a Feature count, Trial Cancellation count, Subscription Cancellation count, other feedback count, and the change from the previous 24-hour period. Include concise read-only highlights. If there is no new feedback, say "No new Paydirt feedback in the last 24 hours." Never create coding tasks, edit files, or act on feedback automatically.`,
      host_behavior: {
        codex: 'When the Codex scheduled-task capability is available and the developer accepts, create a native daily task and confirm its local run time.',
        other_agents: 'Create the recurring task only when the developer accepts and the current host exposes a real scheduling capability. Otherwise provide the saved task prompt and explain that the host must supply scheduling; do not claim a schedule exists.',
      },
    },
    host_app_preservation: {
      existing_feedback_ui: 'Preserve every existing host-app feedback form, button, screen, handler, and destination. Do not replace, repurpose, remove, or reroute one unless the user explicitly asks for that exact change.',
      purchase_flows: 'Preserve every existing purchase, paywall, and subscription flow and its provider packages.',
      regular_feedback: includesRegularFeedback
        ? 'Regular Paydirt feedback was explicitly requested. Add it at the user-approved placement while preserving any existing feedback behavior.'
        : 'Regular Paydirt feedback was not requested. Do not create a custom feedback form or modify any existing feedback UI.',
    },
    agent_actions: [
      '1. Plan (already confirmed): the forms, with the file that holds the real cancel flow, and the destination (Slack and this coding agent recommended) were proposed in one message and confirmed. Do not ask again, and never ask the human for keys or credentials.',
      `2. App, forms, and delivery (done): Paydirt created or reused app ${appId} and the forms above, and delivery is saved as ${deliveryPreference}. Use these exact IDs; do not create duplicates. Change delivery only with paydirt_set_delivery.`,
      requiresSlackDelivery
        ? (slackStatus?.connected && slackStatus.all_forms_assigned
          ? '3. Slack: already connected with every form routed. Do not reconnect; verify with paydirt_slack_status after launch.'
          : '3. Slack, in parallel: call paydirt_connect_slack now and open or show auth_url ("While I build, connect Slack: <link>"). Do NOT wait for Slack; continue building immediately.')
        : '3. Slack: not chosen. Skip every Slack step.',
      '4. Build the live demo now and post short progress lines in chat ("Adding Paydirt…", "Building…", "Launching…"). Install Paydirt 2.2.0 or newer in the existing dependency style, preserving all existing feedback behavior and every purchase/subscription flow (RevenueCat, Superwall, or StoreKit). Write the public SDK key into the project yourself using ios.configuration. Add NSMicrophoneUsageDescription if missing. Perform ios.subscription (resolve provider auto from the host source first) and place Suggest a Feature at the confirmed location. Do not ask the human to make Xcode edits you can make.',
      installTestForm
        ? '5. Place ios.install_verification.app_ready_body_snippet in a safe app-ready lifecycle body. This one-time DEBUG-only trigger opens the Paydirt setup check automatically on first launch, with no navigation. Resolve dependencies, build, launch on a simulator or connected device, and leave the Paydirt setup check visibly open. Never submit a test for the human or include the trigger in release builds. If provider automation cannot compile, report the exact blocker and keep the existing app behavior.'
        : '5. No Paydirt form was returned for install verification. Build and launch anyway, and report that the setup check could not be shown.',
      requiresSlackDelivery
        ? '6. After launch, call paydirt_slack_status. Once connected, call paydirt_list_slack_channels and propose routing in chat (cancellations to one channel and feature ideas to another, or both to the same channel). After the human confirms, save it with paydirt_set_slack_channels and verify with paydirt_slack_status. If Slack is still not connected, re-share auth_url and continue to step 7.'
        : '6. Slack: not chosen. Skip it.',
      `7. First response: ask the human to submit one test in the open setup check by voice or text. Immediately call paydirt_wait_for_response with app_id ${appId} and since set to the launch time, then announce it in their words. If it times out, ask whether they submitted and call it again. Completion is ${testForms.length}/${testForms.length} requested forms verified in the setup check.`,
      deliveryPreference === 'slack'
        ? '8. Daily brief: not included with Slack-only delivery. Do not offer it unless the developer enables coding-agent delivery.'
        : '8. Daily brief: offer the read-only daily 9:00 AM brief. If accepted, create it with the host\'s native scheduled-task capability and daily_brief.task_prompt; if scheduling is unavailable, provide the prompt and say so. This never blocks installation.',
      '9. Report the files changed, build and launch commands and results, delivery route, enabled forms, any narrowly deferred cancellation automation, and an exact repeatable manual test path.',
    ],
    completion_requirements: {
      plan_confirmed_before_creation: true,
      host_app_build_passed: true,
      host_app_launched: true,
      install_test_setup_visible: true,
      build_not_blocked_on_slack: true,
      setup_check_opens_automatically_on_first_launch: true,
      required_test_submissions: testForms.length,
      test_forms_not_submitted_by_agent: true,
      first_response_received_via_wait_tool: true,
      test_deliveries_verified: true,
      automatic_test_trigger_debug_only: true,
      delivery_preference_confirmed_in_chat: true,
      slack_channel_assignment_verified_when_selected: true,
      agent_response_access_read_only_when_selected: true,
      daily_brief_offered_when_coding_agent_delivery: deliveryPreference !== 'slack',
      daily_brief_limitation_reported_when_scheduling_is_unavailable: deliveryPreference !== 'slack',
    },
  };
}

export const PAYDIRT_SERVER_INSTRUCTIONS = [
  'Paydirt adds voice feedback forms to iOS apps. When asked to add Paydirt, inspect the project, then send ONE message: recommend three starting forms (Subscription Cancellation, Trial Cancellation, Suggest a Feature), cite the file where the real cancel flow lives, and recommend sending responses to Slack and here in the agent, so a plain "yes" accepts everything. The human may choose Slack only or agent only, or drop any form. With no subscriptions or cancel flow, say cancellation feedback has nothing to trigger it yet and recommend Suggest a Feature only. Create nothing until the human confirms.',
  'After confirmation, call paydirt_begin_setup (form_plan_confirmed true, use_cases, destinations) and follow agent_actions in order. If Slack was chosen, share the paydirt_connect_slack link and keep building without waiting. Add the SDK, write the SDK key into the project yourself, add the Debug setup check that opens on first launch, then build and launch right away, posting short progress lines.',
  'Rules: never ask the human for keys. Preserve every existing feedback screen and purchase flow. Never submit a test for the human. The only bounded wait is paydirt_wait_for_response (max 90s); never sleep or poll otherwise. Feedback access is read-only: never create tasks or change code from it.',
].join('\n');

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
    instructions: PAYDIRT_SERVER_INSTRUCTIONS,
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
    description: 'iOS bundle ID from the Xcode project (PRODUCT_BUNDLE_IDENTIFIER), used to find or create the app. Hosted sessions need bundle_id, app_name, or app_id.',
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
    description: 'Confirmed forms to install. Recommend subscription_cancellation, trial_cancellation, and feature_request when subscriptions and a cancel flow exist; otherwise feature_request only.',
  },
  form_plan_confirmed: {
    type: 'boolean',
    description: 'Set true only after the developer confirmed the one-message proposal (forms plus destination) or explicitly requested these forms. Nothing is created before this.',
  },
  destinations: {
    type: 'array',
    items: { type: 'string', enum: ['slack', 'codex', 'claude-code'] },
    description: 'Where responses go, from the developer\'s answer to the proposal. Slack plus this agent is recommended, so a plain "yes" means ["slack", "claude-code"] (or "codex" in Codex). Saved as the app\'s delivery preference.',
  },
  cancel_flow_file: {
    type: 'string',
    description: 'Evidence: the project file where the real subscription cancel flow lives, cited in the proposal.',
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

function formPlanConfirmation(args: Record<string, unknown> | undefined) {
  const { subscriptionProvider, featurePlacement } = setupRequestContext(args);
  const hasSubscriptions = subscriptionProvider !== 'none';
  const cancelFlowFile = typeof args?.cancel_flow_file === 'string' && args.cancel_flow_file.trim()
    ? args.cancel_flow_file.trim()
    : null;
  const found = subscriptionProvider === 'auto' || subscriptionProvider === 'custom' ? 'subscriptions' : `${subscriptionProvider} subscriptions`;
  const evidence = cancelFlowFile ? ` and the real cancel flow in ${cancelFlowFile}` : '';
  return {
    success: true,
    status: 'confirmation_required',
    message: hasSubscriptions
      ? `I found ${found}${evidence}. I recommend three starting forms: Subscription Cancellation, Trial Cancellation, and Suggest a Feature (in ${featurePlacement}). Responses go to Slack and here in your coding agent. Reply "yes" to set this up, or tell me Slack only, here only, or which form to drop. Nothing is created until you confirm.`
      : `I didn't find subscriptions or a cancel flow, so cancellation feedback has nothing to trigger it yet. I recommend Suggest a Feature (in ${featurePlacement}). Responses go to Slack and here in your coding agent. Reply "yes" to set this up, or tell me Slack only or here only. Nothing is created until you confirm.`,
    instruction: 'Send message to the human as ONE message, with the cancel-flow file you found as evidence, and wait for their reply. A plain "yes" accepts the recommended forms and destinations ["slack", "claude-code"] (use "codex" in Codex). Then call paydirt_begin_setup with next_arguments plus destinations.',
    confirmation: {
      recommended: hasSubscriptions ? 'add_both' : 'suggest_feature_only',
      options: hasSubscriptions
        ? [
            { id: 'add_both', label: 'Add all three', use_cases: ['subscription_cancellation', 'trial_cancellation', 'feature_request'] },
            { id: 'cancellation_only', label: 'Add both cancellation forms', use_cases: ['subscription_cancellation', 'trial_cancellation'] },
            { id: 'customize', label: 'Customize', follow_up: 'Ask where Suggest a Feature should live: Settings, a detected successful-action trigger, or another location the developer describes.' },
          ]
        : [
            { id: 'suggest_feature_only', label: 'Add Suggest a Feature', use_cases: ['feature_request'] },
            { id: 'customize', label: 'Customize', follow_up: 'Ask whether another form is wanted and where it should appear.' },
          ],
      feature_placement: featurePlacement,
      cancel_flow_file: cancelFlowFile,
      destination: {
        recommended: ['slack', 'claude-code'],
        options: [
          { id: 'both', label: 'Slack and here (recommended)', destinations: ['slack', 'claude-code'] },
          { id: 'slack', label: 'Slack only', destinations: ['slack'] },
          { id: 'agents', label: 'Here only', destinations: ['claude-code'] },
        ],
      },
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

function chosenPreference(args: Record<string, unknown> | undefined): DeliveryPreference | null {
  return args?.destinations === undefined ? null : deliveryPreferenceForDestinations(args.destinations);
}

/** Saves the destination chosen in chat; never falls back to a default when none was chosen. */
async function applyDeliveryPreference(
  token: string,
  appId: string,
  current: DeliveryPreference | null,
  chosen: DeliveryPreference | null
): Promise<DeliveryPreference | null> {
  if (!chosen) return current;
  if (chosen !== current) {
    await api.updateApp(token, appId, { feedback_delivery_preference: chosen });
  }
  return chosen;
}

async function beginSetup(args: Record<string, unknown> | undefined) {
  const { useCases } = setupRequestContext(args);

  if (args?.form_plan_confirmed !== true) return formPlanConfirmation(args);
  chosenPreference(args); // Reject unknown destinations before starting a session.

  const session = await api.startSetupSession();
  const setupParams = new URLSearchParams({ session: session.session_id });
  // Tells the website this client chooses delivery in chat; older clients omit it and are asked to update.
  setupParams.set('delivery', 'chat');
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
    message: 'Open authorization_url for the user to sign in. It only signs in and prepares the app; delivery is saved from this chat. When they return, call paydirt_finish_setup with finish_arguments. The MCP server does not open a browser or block while authorization is pending.',
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
  const grantAppId = stored.grant_app_id;
  const requestedAppId = typeof args?.app_id === 'string' && args.app_id.trim() ? args.app_id.trim() : undefined;
  if (grantAppId && requestedAppId && requestedAppId !== grantAppId) {
    throw new Error('This OAuth grant belongs to a different app. Reauthorize the requested app_id before installing.');
  }

  const { useCases, subscriptionProvider, subscriptionProductIds, featurePlacement } = setupRequestContext(args);

  if (args?.form_plan_confirmed !== true) return formPlanConfirmation(args);
  const chosen = chosenPreference(args);
  const appName = typeof args?.app_name === 'string' && args.app_name.trim() ? args.app_name : undefined;
  const bundleId = typeof args?.bundle_id === 'string' && args.bundle_id.trim() ? args.bundle_id : undefined;
  // A user-scoped grant must name the app; never let ensure-ready fall back to the account's most recent app.
  if (!grantAppId && !requestedAppId && !bundleId && !appName) {
    throw new Error('This authorization covers the whole Paydirt account, so the app must be named. Read PRODUCT_BUNDLE_IDENTIFIER from the Xcode project and call again with bundle_id (and app_name).');
  }

  // User-scoped grants carry no app: ensure-ready creates or reuses one from the inspected identity.
  const ready = await api.ensureReadySetup(stored.auth_token, {
    app_id: requestedAppId ?? grantAppId,
    app_name: appName,
    bundle_id: bundleId,
    app_description: typeof args?.app_description === 'string' ? args.app_description : undefined,
    required_forms: formTypesForUseCases(useCases),
  });
  if (grantAppId && ready.app.id !== grantAppId) {
    throw new Error('Setup returned a different app from this OAuth grant. Reauthorize the requested app before installing.');
  }
  const missingFormTypes = formTypesForUseCases(useCases).filter(
    (type) => !ready.forms.some((form) => form.type === type)
  );
  if (missingFormTypes.length > 0) {
    throw new Error(`Setup reported ready without requested forms: ${missingFormTypes.join(', ')}. Repair this app’s setup before installing.`);
  }
  credentials.set({
    ...stored,
    app_id: ready.app.id,
    api_key: ready.app.api_key,
  });
  const deliveryPreference = await applyDeliveryPreference(
    stored.auth_token,
    ready.app.id,
    configuredPreference(ready.app.feedback_delivery_preference),
    chosen
  );
  if (!deliveryPreference) {
    return deliverySelectionRequired(ready.app.id, 'paydirt_begin_setup', { ...args, app_id: ready.app.id });
  }
  const slackStatus = deliveryPreference === 'agents'
    ? null
    : await api.getSlackStatus(stored.auth_token, ready.app.id);

  return {
    success: true,
    status: 'ready',
    message: 'Paydirt and its required forms are ready. Continue by performing every agent_action below, in order, in the host iOS repository.',
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
  const chosen = chosenPreference(args);
  credentials.set({
    auth_token: status.auth_token,
    app_id: status.app_id,
    api_key: status.api_key,
  });
  // The web flow now only signs in, so the session usually has no preference.
  // Read the app's saved preference (e.g. from paydirt_set_delivery) instead of assuming one.
  const sessionPreference = configuredPreference(status.delivery_preference);
  const savedPreference = sessionPreference ?? (chosen
    ? null
    : configuredPreference((await api.getApp(status.auth_token, status.app_id)).feedback_delivery_preference));
  const deliveryPreference = await applyDeliveryPreference(status.auth_token, status.app_id, savedPreference, chosen);
  if (!deliveryPreference) {
    return deliverySelectionRequired(status.app_id, 'paydirt_finish_setup', setupFinishArguments(sessionId, args));
  }
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
    message: 'Paydirt is authenticated and the requested forms are ready. Continue by performing every agent_action below, in order, in the host iOS repository.',
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
    description: 'Use this when adding Paydirt to an iOS app. Inspect the project first. Without form_plan_confirmed it returns the one-message proposal (three starting forms with cancel-flow evidence, plus the Slack-and-agent destination) and creates nothing. After the human confirms, pass form_plan_confirmed true, use_cases, and destinations. Hosted OAuth sessions create or reuse the app and forms immediately and return the installation contract; stdio sessions return authorization_url (sign-in only) and finish_arguments. Pass a website-supplied app_id to reuse that app.',
    inputSchema: {
      type: 'object' as const,
      properties: setupInputProperties,
      required: [],
    },
  },
  {
    name: 'paydirt_finish_setup',
    description: 'Use this when the user has signed in through the authorization URL returned by paydirt_begin_setup. Checks one setup session and returns immediately; if pending, do not loop or sleep. When ready, saves credentials, saves the chosen destinations, and returns the ordered installation contract. Returns delivery_selection_required (never a default) when no destination was chosen.',
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
    description: 'Use this when Slack delivery was chosen, right after setup and in parallel with the build, or to repair Slack later. Returns auth_url for Slack\'s own Allow screen, which lands on paydirt.ai/slack/connected. Open or show it to the human ("While I build, connect Slack: <link>") and keep building without waiting. When they are done, list channels, propose routing in chat, and save it with paydirt_set_slack_channels. Only completed Q&A is sent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description: 'The Paydirt app ID. Defaults to the app returned by setup in this session.',
        },
        delivery: {
          type: 'string',
          enum: ['both', 'slack'],
          description: 'Delivery to save when Slack connects. Defaults to the app\'s saved preference when it is both or slack.',
        },
      },
      required: [],
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
          description: 'The Paydirt app ID. Defaults to the app returned by setup in this session.',
        },
      },
      required: [],
    },
  },
  {
    name: 'paydirt_set_form_channel',
    description: 'Use this when one specific form (usually a custom named form) must deliver to its own Slack channel ID. For the standard cancellation and Suggest a Feature routing, prefer paydirt_set_slack_channels. Replaces that form’s current channel assignment and should be verified afterward.',
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
    name: 'paydirt_set_delivery',
    description: 'Use this when the developer has chosen where responses go (in their reply to the setup proposal, after delivery_selection_required, or to change it later). Maps destinations to the app\'s delivery preference: Slack plus an agent is both, Slack alone is slack, agents alone is agents. Saves it on the app.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description: 'The Paydirt app ID. Defaults to the app returned by setup in this session.',
        },
        destinations: {
          type: 'array',
          items: { type: 'string', enum: ['slack', 'codex', 'claude-code'] },
          minItems: 1,
          description: 'Chosen destinations. A plain "yes" to the recommended plan means ["slack", "claude-code"] (or "codex" in Codex).',
        },
      },
      required: ['destinations'],
    },
  },
  {
    name: 'paydirt_set_slack_channels',
    description: 'Use this when the human has confirmed Slack routing in chat after paydirt_list_slack_channels. Routes cancellation forms (subscription and trial) to one channel and Suggest a Feature and custom forms to another, or both to the same channel. Prefer this over paydirt_set_form_channel. An omitted channel keeps its current destination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description: 'The Paydirt app ID. Defaults to the app returned by setup in this session.',
        },
        feature_channel_id: {
          type: 'string',
          description: 'Slack channel ID for Suggest a Feature and custom forms.',
        },
        cancellation_channel_id: {
          type: 'string',
          description: 'Slack channel ID for Subscription Cancellation and Trial Cancellation.',
        },
      },
      required: [],
    },
  },
  {
    name: 'paydirt_wait_for_response',
    description: 'Use this when the app is running with the setup check open and you have asked the human to submit a test. This is the only allowed bounded wait: it checks for a completed response every 3 seconds for up to timeout_seconds (default 45, max 90) and returns received with the response, or timed_out. On timed_out, ask whether they submitted and call again.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description: 'The Paydirt app ID. Defaults to the app returned by setup in this session.',
        },
        since: {
          type: 'string',
          description: 'ISO-8601 time in UTC; only responses completed at or after it count. Use the launch time. Defaults to two minutes ago; never later than now.',
        },
        form_id: {
          type: 'string',
          description: 'Only wait for this form (optional).',
        },
        timeout_seconds: {
          type: 'number',
          minimum: 1,
          maximum: 90,
          description: 'How long to wait (default 45, max 90).',
        },
      },
      required: [],
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
    description: 'Use this when Slack delivery was chosen: after launch to see whether the human finished Slack authorization, and after paydirt_set_slack_channels to verify routing. Reports the connection, channels, and whether every installed form is assigned. Do not call it for agent-only delivery.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app_id: {
          type: 'string',
          description: 'The Paydirt app ID. Defaults to the app returned by setup in this session.',
        },
      },
      required: [],
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
  paydirt_set_delivery: {
    title: 'Set Feedback Delivery', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  },
  paydirt_set_slack_channels: {
    title: 'Route Slack Channels', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  },
  paydirt_wait_for_response: {
    title: 'Wait for Test Response', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
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
    type: 'object',
    properties: {
      auth_url: { type: 'string' },
      app_id: { type: 'string' },
      instruction: { type: 'string' },
    },
    required: ['auth_url'],
  },
  paydirt_set_delivery: {
    type: 'object',
    properties: {
      app_id: { type: 'string' },
      feedback_delivery_preference: { type: 'string', enum: ['both', 'slack', 'agents'] },
      next: { type: 'string' },
    },
    required: ['app_id', 'feedback_delivery_preference'],
  },
  paydirt_set_slack_channels: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      feature_channel_id: { type: ['string', 'null'] },
      cancellation_channel_id: { type: ['string', 'null'] },
    },
    required: ['success'],
  },
  paydirt_wait_for_response: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['received', 'timed_out'] },
      response: { type: 'object' },
      announce: { type: 'string' },
      next: { type: 'string' },
    },
    required: ['status'],
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

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  const sessionAppId = (): string => {
    const explicit = typeof args?.app_id === 'string' ? args.app_id.trim() : '';
    const appId = explicit || credentials.get()?.app_id || '';
    if (!appId) throw new Error('app_id is required (run setup first or pass app_id)');
    return appId;
  };

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

      case 'paydirt_connect_slack': {
        const appId = sessionAppId();
        let delivery: 'both' | 'slack' | undefined = args?.delivery === 'both' || args?.delivery === 'slack' ? args.delivery : undefined;
        if (!delivery) {
          const saved = (await api.getApp(AUTH_TOKEN, appId)).feedback_delivery_preference;
          if (saved === 'both' || saved === 'slack') delivery = saved;
        }
        const returnTo = `/slack/connected?app_id=${encodeURIComponent(appId)}`;
        const install = await api.getSlackInstallUrl(AUTH_TOKEN, appId, {
          delivery,
          channelSelection: 'manual',
          returnTo,
        });
        result = {
          auth_url: install.auth_url,
          app_id: appId,
          delivery: delivery ?? null,
          return_to: returnTo,
          instruction: 'Open auth_url for the human, or show it ("While I build, connect Slack: <link>"), and keep working without waiting. When they say done, call paydirt_list_slack_channels, propose routing in chat, and save it with paydirt_set_slack_channels.',
        };
        break;
      }

      case 'paydirt_set_delivery': {
        const appId = sessionAppId();
        const preference = deliveryPreferenceForDestinations(args?.destinations);
        const app = await api.updateApp(AUTH_TOKEN, appId, { feedback_delivery_preference: preference });
        result = {
          app_id: appId,
          feedback_delivery_preference: app.feedback_delivery_preference ?? preference,
          destinations: args?.destinations,
          next: preference === 'agents'
            ? 'No Slack step. Responses stay available read-only through paydirt_wait_for_response and paydirt_get_responses.'
            : 'Call paydirt_connect_slack now and share auth_url while you keep building; pick channels in chat after launch.',
        };
        break;
      }

      case 'paydirt_set_slack_channels': {
        const appId = sessionAppId();
        const featureChannel = typeof args?.feature_channel_id === 'string' && args.feature_channel_id.trim()
          ? args.feature_channel_id.trim()
          : undefined;
        const cancellationChannel = typeof args?.cancellation_channel_id === 'string' && args.cancellation_channel_id.trim()
          ? args.cancellation_channel_id.trim()
          : undefined;
        if (!featureChannel && !cancellationChannel) {
          throw new Error('Provide feature_channel_id, cancellation_channel_id, or both');
        }
        // The API replaces both destinations, so keep the current one for an omitted channel.
        const current = featureChannel && cancellationChannel
          ? null
          : await api.getSlackStatus(AUTH_TOKEN, appId);
        const routing = [
          { field: 'feature_channel_id', channel: featureChannel ?? current?.feature_channel_id ?? null, forms: current?.assignments?.feature?.total ?? 0 },
          { field: 'cancellation_channel_id', channel: cancellationChannel ?? current?.cancellation_channel_id ?? null, forms: current?.assignments?.cancellation?.total ?? 0 },
        ];
        // Mirrors the API: every installed form type needs a destination.
        const needed = routing.filter((route) => route.forms > 0);
        if (needed.some((route) => !route.channel)) {
          throw new Error(needed.length > 1
            ? 'This is the first time routing; pass both feature_channel_id and cancellation_channel_id (they may be the same channel).'
            : `This is the first time routing; pass ${needed[0].field}.`);
        }
        result = await api.setSlackChannels(AUTH_TOKEN, appId, {
          feature_channel_id: routing[0].channel,
          cancellation_channel_id: routing[1].channel,
        });
        break;
      }

      case 'paydirt_wait_for_response': {
        const appId = sessionAppId();
        const progressToken = extra._meta?.progressToken;
        result = await waitForResponse(AUTH_TOKEN, {
          app_id: appId,
          since: args?.since,
          form_id: args?.form_id,
          timeout_seconds: args?.timeout_seconds,
        }, {
          ...realWaitDependencies,
          signal: extra.signal,
          onPoll: progressToken === undefined ? undefined : (elapsed, total) => {
            void extra.sendNotification({
              method: 'notifications/progress',
              params: { progressToken, progress: elapsed, total, message: 'Waiting for the test response' },
            }).catch(() => {});
          },
        });
        break;
      }

      case 'paydirt_list_slack_channels':
        result = await api.listSlackChannels(AUTH_TOKEN, sessionAppId());
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
        result = await api.getSlackStatus(AUTH_TOKEN, sessionAppId());
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
