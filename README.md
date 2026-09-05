# Paydirt MCP

[![CI](https://github.com/Paydirt-AI/paydirt-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Paydirt-AI/paydirt-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/paydirt-mcp)](https://www.npmjs.com/package/paydirt-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

MCP Registry name: `io.github.Paydirt-AI/paydirt-mcp`

The agent-native installer and control plane for [Paydirt](https://www.paydirt.ai), an iOS SDK for Suggest a Feature, trial cancellation, and subscription cancellation.

Paydirt MCP lets a coding agent create forms, place them in an iOS app, connect Slack, build and launch the host app, leave a Debug-only requested-form setup check open for immediate verification, and read raw feedback. Paydirt supports native StoreKit, RevenueCat, Superwall, app-owned billing, and apps without subscriptions.

A generic installation first confirms cancellation feedback and Suggest a Feature, then creates the selected forms after Google sign-in. Browser onboarding asks whether completed feedback should go to Slack and coding agents (recommended), Slack only, or coding agents only. The agent then builds and opens the requested-form setup check on a simulator or connected iPhone.

## One browser flow, from either entry point

Paydirt provides voice-first cancellation feedback and voice Suggest a Feature
forms for iOS, working with the app's existing RevenueCat or StoreKit setup and
connected to Slack and coding agents.

- Agent start: inspect the iOS project, use the developer's explicitly requested
  form plan, and open the authorization URL from `paydirt_begin_setup`.
- Website start: the developer signs in at https://www.paydirt.ai/setup, selects
  their app, and connects Slack. They then receive an installation prompt with
  the prepared `app_id`. Pass that ID to `paydirt_begin_setup`; never create a
  second app merely because setup began on the website.
- In both paths, the human authorizes Paydirt and Slack in the browser. Existing
  delivery preferences and healthy Slack assignments are reused. Only request
  Slack authorization when missing, incomplete, or explicitly requested.
- After authorization, `paydirt_finish_setup` returns the installation contract.
  Continue in the same project and conversation using the exact app/form IDs.
  Preparing forms is not proof that the SDK is installed or delivery is verified.

An explicit request to install specified forms counts as confirmation of that
scope. Set `form_plan_confirmed: true`; ask only about missing or ambiguous
choices, not whether to repeat work already requested.

Example request:

> Add Paydirt voice cancellation feedback and a voice Suggest a Feature form to
> my iOS app. Use my existing RevenueCat or StoreKit setup, connect Slack during
> browser authorization, then build and verify my app.

## Install in Codex

```bash
codex mcp add paydirt -- npx --yes --prefer-online paydirt-mcp@latest
```

After first registration, follow the refresh requested by your Codex client.
Current Codex desktop builds may require you to quit and reopen Codex before a
brand-new MCP server becomes visible. Return to the same task and ask:

> Add Paydirt and show me it working.

This is a one-time Codex tool-discovery refresh, not a Paydirt authentication
requirement. Once Paydirt is visible, Paydirt and Slack authorization do not
require another restart. The already loaded `paydirt_begin_setup` and
`paydirt_finish_setup` tools complete browser authorization in the same task
and the same MCP process.

To remove the server later:

```bash
codex mcp remove paydirt
```

## Install in Claude Code

```bash
claude mcp add paydirt -- npx --yes --prefer-online paydirt-mcp@latest
```

The public Paydirt Claude plugin marketplace is also included in this repository. After the public repository is available:

```text
/plugin marketplace add Paydirt-AI/paydirt-mcp
/plugin install paydirt@paydirt-plugins
```

The plugin bundles both the Paydirt installation workflow and the pinned MCP server configuration.

Other MCP hosts can launch the same stdio command:

```json
{
  "mcpServers": {
    "paydirt": {
      "command": "npx",
      "args": ["--yes", "--prefer-online", "paydirt-mcp@latest"]
    }
  }
}
```

Requires Node.js 18 or newer.

## Authentication

Authentication is an explicit, headless-safe two-step flow:

1. The agent inspects the app and uses the explicitly requested form plan. An explicit request naming the forms already counts as confirmation. If the scope is unclear, call `paydirt_begin_setup` without confirmation to receive the recommended plan and ask one concise question.
2. After confirmation, the agent calls `paydirt_begin_setup` with `form_plan_confirmed: true`. It immediately receives an `authorization_url`, `session_id`, and exact `finish_arguments`. The MCP process never launches a browser, sleeps, or polls.
3. Open `authorization_url` in any browser and sign in to Paydirt with Google. Paydirt creates the app and selected forms, then asks for Slack and coding agents (recommended), Slack only, or coding agents only.
4. When Slack is selected, complete Slack OAuth. Choose your own workspace and channels. Paydirt assigns the requested forms and verifies routing before setup completes.
5. The agent calls `paydirt_finish_setup`, respects the saved delivery choice, installs Paydirt, builds and launches the app, and leaves the requested-form setup check visibly open. The developer submits each installed form; Slack delivery is verified only when every required test reaches its selected channel. Separately verify actual trial and paid cancellation triggers with the host subscription provider.
6. The coding-agent delivery choices disclose and include a read-only daily brief. After verification, a host with native scheduling creates a 9:00 AM local task that calls `paydirt_get_feedback_digest`; unsupported hosts return the reusable prompt and report the limitation without pretending a schedule was created. Slack-only delivery does not include it.

`paydirt_setup` remains as a compatibility alias: call it without `session_id` to begin and with `session_id` to finish.

Credentials are saved locally at `~/.paydirt/credentials.json` with owner-only permissions. They are not written to an app repository or sent anywhere except `api.paydirt.ai`. For ephemeral environments, set `PAYDIRT_AUTH_TOKEN` instead.

## Daily feedback brief

`paydirt_get_feedback_digest` returns a read-only period summary designed for scheduled tasks: total completed responses, Suggest a Feature, Trial Cancellation, Subscription Cancellation, other feedback, the change from the preceding equal period, and concise highlights. A quiet day explicitly reports zero. Digests never create coding tasks or modify an app automatically.

## Natural agent workflows

### Add a form at an in-app action

Ask:

> Add a feedback form titled “Export Feedback” after a successful export and send it to #product-feedback.

The agent should use `paydirt_add_feedback_form`. It reuses an existing custom form with the same normalized title, preserves the requested placement, resolves Slack when possible, and returns the exact Swift presentation call. A remote form is not considered installed until the agent edits and builds the host app.

Supported triggers are user taps, successful in-app actions, screen appearance, and app-owned custom conditions.

### Install cancellation feedback

The agent inspects the app before setup and selects the existing subscription source of truth:

- Native StoreKit uses Paydirt's built-in StoreKit integration.
- RevenueCat uses installer-managed compatibility source and the familiar `Paydirt.enableRevenueCatIntegration(...)` call, avoiding duplicate package dependencies.
- Native StoreKit covers ordinary App Store subscriptions, including apps where Superwall is only the paywall.
- App-owned billing emits Paydirt's provider-independent cancellation event.
- Apps without subscriptions can install manual feedback alone.

The agent must preserve all existing host-app feedback forms, buttons, screens,
handlers, destinations, and side effects. It may only add or change regular
feedback when the user explicitly requests that exact placement. If a requested
cancellation bridge is blocked, the agent reports the narrow provider blocker,
preserves the existing app behavior, and completes every unaffected requested
form.

An older RevenueCat version is not a blocker. The agent keeps the installed
version and adapts the installer-managed integration source to the customer-info or
purchaser-info API already compiling in the app. Newer optional metadata may be
omitted, or Paydirt can be called from the app's existing confirmed RevenueCat
cancellation path.

### Deliver to Slack and coding agents

Slack receives one message after a conversation finishes, containing the exact raw questions and answers. An optional AI summary may follow the raw conversation. Coding-agent tools expose responses read-only; Paydirt does not automatically take action on feedback.

## Tools

| Tool | Purpose |
| --- | --- |
| `paydirt_begin_setup` | Start non-blocking browser authorization |
| `paydirt_finish_setup` | Check authorization once and return the installation contract |
| `paydirt_setup` | Backward-compatible begin/finish alias |
| `paydirt_add_feedback_form` | Create/reuse a named form and return its host-app placement contract |
| `paydirt_list_apps`, `paydirt_create_app`, `paydirt_get_app`, `paydirt_update_app` | Manage apps |
| `paydirt_list_forms`, `paydirt_create_form`, `paydirt_get_form`, `paydirt_update_form`, `paydirt_toggle_form`, `paydirt_delete_form` | Manage forms |
| `paydirt_get_responses` | Read raw conversations using a stable cursor |
| `paydirt_get_summary`, `paydirt_ask` | Read optional AI analysis |
| `paydirt_connect_slack`, `paydirt_slack_status`, `paydirt_list_slack_channels`, `paydirt_set_form_channel` | Connect and configure Slack delivery |
| `paydirt_health_check` | Verify API connectivity and credentials |

## Development

```bash
npm ci
npm test
npm pack --dry-run
```

The repository intentionally contains only the public MCP client. Paydirt's API, dashboard, infrastructure, and operational configuration remain private.

Official MCP Registry metadata lives at [`.mcp/server.json`](.mcp/server.json). It describes the current npm stdio package; Paydirt does not claim a remote MCP transport until a public HTTPS endpoint is deployed and verified.

See [SUPPORT.md](SUPPORT.md) for support, [SECURITY.md](SECURITY.md) before reporting a vulnerability, and [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[MIT](LICENSE)


## Hosted transport

The same package also includes the authenticated Streamable HTTP server at
`https://mcp.paydirt.ai/mcp`. See [HOSTED.md](HOSTED.md) for deployment,
OAuth configuration, session isolation, and release verification. Discovery metadata
is at `https://mcp.paydirt.ai/.well-known/oauth-protected-resource/mcp`.
A reachable health or metadata endpoint alone does not verify authenticated tool use.
