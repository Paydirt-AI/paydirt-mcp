# Paydirt MCP

[![CI](https://github.com/Paydirt-AI/paydirt-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Paydirt-AI/paydirt-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/paydirt-mcp)](https://www.npmjs.com/package/paydirt-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

MCP Registry name: `io.github.Paydirt-AI/paydirt-mcp`

The agent-native installer and control plane for [Paydirt](https://www.paydirt.ai), an iOS SDK for Suggest a Feature, trial cancellation, and subscription cancellation.

Paydirt MCP lets a coding agent add Paydirt to an iOS app from chat: propose the forms, create them, write the SDK key into the project, build and launch the app with a Debug setup check open, route responses to Slack and the agent, and read raw feedback. Paydirt supports native StoreKit, RevenueCat, Superwall, app-owned billing, and apps without subscriptions.

## Install

Pick one. The hosted server is the golden path: sign in with Google once and never paste a key.

**Claude Code plugin** (bundles the install skill):

```text
/plugin marketplace add Paydirt-AI/paydirt-mcp
/plugin install paydirt@paydirt-plugins
```

**Claude Code, hosted server:**

```bash
claude mcp add --transport http paydirt https://mcp.paydirt.ai/mcp
```

**Codex, hosted server:**

```bash
codex mcp add paydirt --url https://mcp.paydirt.ai/mcp
```

**Fallback, local stdio** (any MCP host; Node.js 18 or newer):

```bash
npx -y paydirt-mcp
```

```json
{
  "mcpServers": {
    "paydirt": {
      "command": "npx",
      "args": ["-y", "paydirt-mcp"]
    }
  }
}
```

Current Codex desktop builds may need a restart before a newly added MCP server appears. That is a one-time tool-discovery refresh, not a Paydirt requirement.

## First run

Say:

> Add Paydirt to this app. Set up cancellation feedback and Suggest a Feature.

1. **Connect.** The agent host opens a browser tab: Continue with Google, then Allow. The tab says to return to your agent. No keys.
2. **One proposal.** The agent inspects the project and sends one message: Subscription Cancellation, Trial Cancellation, and Suggest a Feature, citing the file where your real cancel flow lives, with responses going to Slack and here in the agent. Reply "yes", or choose Slack only, here only, or drop a form. Without subscriptions, it says cancellation feedback has nothing to trigger it yet and recommends Suggest a Feature only. Nothing is created until you confirm.
3. **Live demo.** The agent creates the app and forms, saves your destination, and, if you chose Slack, shares a Slack link while it keeps working. It adds the SDK, writes the key into your project, adds a Debug setup check that opens on first launch, and builds and launches the app.
4. **Slack routing.** After Slack's Allow screen, the agent lists your channels and proposes routing in chat, for example cancellations to one channel and feature ideas to another. It saves the routing after you confirm.
5. **First response.** Submit one test answer by voice or text. The agent is already waiting with `paydirt_wait_for_response` and announces it when it lands.

Existing feedback screens and purchase flows are preserved. A daily read-only brief is offered when responses come to the coding agent.

With the local stdio server, `paydirt_begin_setup` returns an `authorization_url` that only signs you in, and `paydirt_finish_setup` returns the same installation contract. The MCP process never opens a browser, sleeps, or polls; the only bounded wait is `paydirt_wait_for_response` (max 90 seconds). `paydirt_setup` remains as a compatibility alias.

Local credentials are saved at `~/.paydirt/credentials.json` with owner-only permissions. They are not written to an app repository or sent anywhere except `api.paydirt.ai`. For ephemeral environments, set `PAYDIRT_AUTH_TOKEN` instead.

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
| `paydirt_set_delivery` | Save where responses go: Slack, the coding agent, or both |
| `paydirt_connect_slack`, `paydirt_slack_status`, `paydirt_list_slack_channels`, `paydirt_set_slack_channels` | Connect Slack and route cancellations and feature ideas |
| `paydirt_set_form_channel` | Route one custom form to its own channel |
| `paydirt_wait_for_response` | Wait up to 90 seconds for the first test response |
| `paydirt_health_check` | Verify API connectivity and credentials |

## Development

```bash
npm ci
npm test
npm pack --dry-run
```

The repository intentionally contains only the public MCP client. Paydirt's API, dashboard, infrastructure, and operational configuration remain private.

Official MCP Registry metadata lives at [`.mcp/server.json`](.mcp/server.json). It lists the npm stdio package and the hosted Streamable HTTP endpoint at `https://mcp.paydirt.ai/mcp`.

See [SUPPORT.md](SUPPORT.md) for support, [SECURITY.md](SECURITY.md) before reporting a vulnerability, and [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[MIT](LICENSE)


## Hosted transport

The same package also includes the authenticated Streamable HTTP server at
`https://mcp.paydirt.ai/mcp`. See [HOSTED.md](HOSTED.md) for deployment,
OAuth configuration, session isolation, and release verification. Discovery metadata
is at `https://mcp.paydirt.ai/.well-known/oauth-protected-resource/mcp`.
A reachable health or metadata endpoint alone does not verify authenticated tool use.
