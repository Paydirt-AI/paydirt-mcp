#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as api from './api.js';
import { homedir } from 'os';
import { chmodSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
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

// Credentials file path
const CREDENTIALS_DIR = join(homedir(), '.paydirt');
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.json');

interface StoredCredentials {
  auth_token: string;
  app_id?: string;
  api_key?: string;
}

type PaydirtUseCase = 'regular_feedback' | 'trial_cancellation' | 'subscription_cancellation';

const DEFAULT_USE_CASES: PaydirtUseCase[] = [
  'regular_feedback',
  'trial_cancellation',
  'subscription_cancellation',
];

function requestedUseCases(value: unknown): PaydirtUseCase[] {
  if (!Array.isArray(value)) return DEFAULT_USE_CASES;
  const valid = value.filter((item): item is PaydirtUseCase =>
    typeof item === 'string' && DEFAULT_USE_CASES.includes(item as PaydirtUseCase)
  );
  return valid.length > 0 ? [...new Set(valid)] : DEFAULT_USE_CASES;
}

function formTypesForUseCases(useCases: PaydirtUseCase[]): string[] {
  const types = useCases.map((useCase) => {
    if (useCase === 'subscription_cancellation') return 'cancellation';
    if (useCase === 'trial_cancellation') return 'trial_expiration';
    return 'custom';
  });
  return [...new Set(types)];
}

function installationContract(
  apiKey: string,
  appId: string,
  forms: Array<Pick<api.Form, 'id' | 'type' | 'name'>>,
  useCases: PaydirtUseCase[],
  subscriptionProvider: SubscriptionProvider,
  subscriptionProductIds: string[]
) {
  const includesRegularFeedback = useCases.includes('regular_feedback');
  const byType = new Map(forms.map((form) => [form.type, form]));
  const cancellationId = byType.get('cancellation')?.id;
  const trialId = byType.get('trial_expiration')?.id;
  const feedbackId = byType.get('custom')?.id;
  const prefetchIds = [cancellationId, trialId, feedbackId].filter(Boolean) as string[];
  const installTestForm = byType.get('custom') ?? byType.get('trial_expiration') ?? byType.get('cancellation') ?? forms[0];
  const installTestPresentation = installTestForm
    ? `Paydirt.presentForm(formId: "${installTestForm.id}", metadata: ["paydirt_install_test": true])`
    : null;
  const installTestKey = installTestForm
    ? `paydirt.install-test.${appId}.${installTestForm.id}`
    : null;
  const installTestSnippet = installTestForm && installTestKey
    ? `#if DEBUG
let paydirtInstallTestKey = "${installTestKey}"
if !UserDefaults.standard.bool(forKey: paydirtInstallTestKey) {
    UserDefaults.standard.set(true, forKey: paydirtInstallTestKey)
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
      minimum_version: '2.0.0',
      deployment_target: 'iOS 15.0',
      provider_independent_core: true,
      privacy_manifest: 'Bundled in Paydirt 2.0.0; do not copy it into the host app.',
      theming: 'Use .automatic to inherit system light/dark appearance, .light or .dark, or construct PaydirtTheme with app colors.',
      info_plist: {
        NSMicrophoneUsageDescription: 'Used to record voice feedback',
      },
      configuration,
      subscription,
      regular_feedback_trigger: feedbackId
        ? `Paydirt.presentForm(formId: "${feedbackId}", userId: currentUserId)`
        : null,
      install_verification: installTestForm ? {
        required: true,
        form_id: installTestForm.id,
        form_name: installTestForm.name,
        presentation: installTestPresentation,
        app_ready_body_snippet: installTestSnippet,
        repeat_test_reset: `UserDefaults.standard.removeObject(forKey: "${installTestKey}")`,
        behavior: 'Add a DEBUG-only one-time app-ready trigger, build and launch the app on an available simulator or connected development device, and leave this form visibly open for the developer. Never submit it for them. Do not include the automatic trigger in release builds.',
      } : null,
    },
    slack: {
      required_for_delivery: true,
      next_tools: ['paydirt_slack_status', 'paydirt_connect_slack', 'paydirt_list_slack_channels', 'paydirt_set_form_channel'],
      default: 'Slack OAuth creates or reuses an app-specific public channel named #<app-name>-feedback and assigns every installed form to it.',
      rule: 'After authorization, call paydirt_slack_status and verify all_forms_assigned. Ask the user to choose a channel only when they requested a different one or their workspace blocked automatic channel creation. Do not report installation complete until assignment is verified.',
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
      'Install Paydirt 2.0.0 or newer in the existing dependency style. Paydirt has no third-party package dependency, so preserve the host app\'s existing RevenueCat, Superwall, or StoreKit setup. Do not ask the user to perform Xcode edits that the agent can safely make.',
      'Connect Paydirt to the subscription code already working in the app. Keep the installed provider packages, inspect the APIs already used by the app, adapt the small host-source bridge or use the existing customer-info/cancellation path, and omit unavailable optional metadata rather than blocking installation.',
      'Add NSMicrophoneUsageDescription if it is missing.',
      'Configure Paydirt using the exact public SDK key and form IDs above, then perform every instruction in ios.subscription. If its provider is auto, resolve it from the host source before proceeding.',
      includesRegularFeedback
        ? 'Add regular Paydirt feedback only at the user-approved UI or lifecycle event, preserving all existing feedback behavior. Wire cancellation through the provider contract only when cancellation feedback was requested.'
        : 'Do not create or wire regular feedback and do not modify existing feedback UI. Wire only the requested trial and/or subscription cancellation forms through the provider contract.',
      'Connect Slack. By default, let OAuth create or reuse #<app-name>-feedback and assign every installed form automatically. After authorization call paydirt_slack_status and verify all_forms_assigned. Only list channels or ask the user to choose one if they requested a different channel or their workspace blocked automatic creation.',
      'Resolve dependencies and build the app. If provider automation cannot compile, report the exact provider blocker and preserve the existing app behavior. Do not add or replace regular feedback as a fallback unless the user explicitly requests it.',
      installTestForm
        ? `After the build succeeds, place ios.install_verification.app_ready_body_snippet inside a safe app-ready lifecycle body. Launch the app on an available simulator or connected development device and leave the Paydirt form visibly open so the developer can answer it immediately. Do not submit the form for them, do not run this automatic trigger in release builds, and do not claim installation is complete merely because the code compiled.`
        : 'Report that no Paydirt form was returned for immediate install verification and do not claim the form test passed.',
      'Report the files changed, build and launch commands and results, Slack assignment, enabled use cases, the form left open for immediate verification, any narrowly deferred cancellation automation, and an exact repeatable manual test path.',
    ],
    completion_requirements: {
      host_app_build_passed: true,
      host_app_launched: true,
      install_test_form_visible: true,
      test_form_not_submitted_by_agent: true,
      automatic_test_trigger_debug_only: true,
      slack_channel_assignment_verified: true,
    },
  };
}

// Read credentials from file or environment
function getCredentials(): StoredCredentials | null {
  // First check environment variable (backwards compatible)
  if (process.env.PAYDIRT_AUTH_TOKEN) {
    return { auth_token: process.env.PAYDIRT_AUTH_TOKEN };
  }

  // Then check credentials file
  if (existsSync(CREDENTIALS_FILE)) {
    try {
      const data = readFileSync(CREDENTIALS_FILE, 'utf-8');
      return JSON.parse(data) as StoredCredentials;
    } catch {
      return null;
    }
  }

  return null;
}

// Save credentials to file
function saveCredentials(credentials: StoredCredentials): void {
  if (!existsSync(CREDENTIALS_DIR)) {
    mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  }
  chmodSync(CREDENTIALS_DIR, 0o700);
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  chmodSync(CREDENTIALS_FILE, 0o600);
}

// Get auth token (helper for existing code)
function getAuthToken(): string {
  const creds = getCredentials();
  return creds?.auth_token || '';
}

const server = new Server(
  {
    name: 'paydirt-mcp-server',
    version: '2.1.4',
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: `Paydirt is an agent-installed iOS SDK for regular feedback, named contextual forms, trial cancellation, and subscription cancellation. A generic installation includes both trial cancellation and paid subscription cancellation by default. Install the use cases the user requests, and preserve every existing host-app feedback form, button, screen, handler, and destination unless the user explicitly asks for that exact change. Inspect the iOS project first, identify whether StoreKit, RevenueCat, Superwall, or an app-owned cancellation flow already supplies subscription state when cancellation forms are requested, then authenticate with paydirt_begin_setup and paydirt_finish_setup (paydirt_setup remains a compatibility alias). Connect Paydirt to the subscription code already working in the app. Preserve the installed subscription packages and adapt the small host-source bridge to the APIs already compiling there; unavailable optional metadata must not block installation. Never wait or open a browser inside the MCP process: return the authorization URL to the user and continue only after they authorize. Perform every returned agent_action in the repository. When the user asks for a named feedback form at a screen, button, lifecycle moment, or in-app action, use paydirt_add_feedback_form and preserve their placement description and existing host behavior exactly. Create or reuse forms; never create duplicates when a matching form exists. Slack OAuth should create or reuse #<app-name>-feedback and assign every installed form automatically; ask the user to choose only when they requested a different channel or the workspace blocks channel creation. Raw questions and answers are the source of truth; AI summaries are optional. Never imply that Paydirt or another agent will take action on feedback. Do not stop at returning snippets when the user authorized installation: edit the host app at the requested placement, resolve dependencies, build, and verify the host app. If a requested subscription bridge is blocked, report the exact blocker and preserve existing app behavior while completing every unaffected requested form.`,
  }
);

const setupInputProperties = {
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
      enum: ['regular_feedback', 'trial_cancellation', 'subscription_cancellation'],
    },
    description: 'Feedback experiences to install. Defaults to regular feedback, trial cancellation, and subscription cancellation.',
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

  return { useCases, subscriptionProvider, subscriptionProductIds };
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
  const { useCases } = setupRequestContext(args);
  const session = await api.startSetupSession();
  const setupParams = new URLSearchParams({ session: session.session_id });
  setupParams.set('required_forms', formTypesForUseCases(useCases).join(','));

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

async function finishSetup(
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

  saveCredentials({
    auth_token: status.auth_token,
    app_id: status.app_id,
    api_key: status.api_key,
  });
  const { useCases, subscriptionProvider, subscriptionProductIds } = setupRequestContext(args);
  const contract = installationContract(
    status.api_key,
    status.app_id,
    status.forms || [],
    useCases,
    subscriptionProvider,
    subscriptionProductIds
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
    description: 'Use this when installing Paydirt for a new user, machine, or iOS app and authentication has not been completed. Inspect the host first and pass its app identity, use cases, and subscription provider. Returns authorization_url, session_id, and exact finish_arguments immediately; it never launches a browser, sleeps, or polls.',
    inputSchema: {
      type: 'object' as const,
      properties: setupInputProperties,
      required: [],
    },
  },
  {
    name: 'paydirt_finish_setup',
    description: 'Use this when the user has opened the authorization URL returned by paydirt_begin_setup. Checks one setup session and returns immediately. If pending, do not loop or sleep. When ready, securely saves credentials and returns the complete host-app installation, Slack, build, and verification contract.',
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
          description: 'Optional Slack channel name (with or without #) or channel ID. If omitted, the contract still requires the agent to connect Slack and assign a channel before completion.',
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
    name: 'paydirt_connect_slack',
    description: 'Use this when the user asks to connect Slack or setup requires Slack delivery. Returns the Slack OAuth URL. Authorization creates or reuses #<app-name>-feedback and assigns every installed form automatically when workspace policy allows it.',
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
    description: 'Use this when Slack authorization has finished and before declaring setup complete. Reports the default app-specific feedback channel and whether every installed form is assigned. List or select channels only when automatic creation was blocked or the user requested another channel.',
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
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Setup tools do not require auth. They return immediately and never launch a browser or poll.
  if (name === 'paydirt_setup' || name === 'paydirt_begin_setup' || name === 'paydirt_finish_setup') {
    try {
      const sessionId = typeof args?.session_id === 'string' ? args.session_id : '';
      const result = name === 'paydirt_finish_setup' || sessionId
        ? await finishSetup(sessionId, args)
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
  const AUTH_TOKEN = getAuthToken();
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

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Paydirt MCP server running on stdio');
}

main().catch(console.error);
