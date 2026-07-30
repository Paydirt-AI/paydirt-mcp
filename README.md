# Paydirt MCP

[![CI](https://github.com/Paydirt-AI/paydirt-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Paydirt-AI/paydirt-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/paydirt-mcp)](https://www.npmjs.com/package/paydirt-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

The agent-native installer and control plane for [Paydirt](https://www.paydirt.ai), an iOS SDK for regular feedback, trial cancellation, and subscription cancellation.

Paydirt MCP lets a coding agent create forms, place them in an iOS app, connect Slack, build the host app, and read raw feedback. Paydirt supports native StoreKit, RevenueCat, Superwall, app-owned billing, and apps without subscriptions.

## Install in Codex

```bash
codex mcp add paydirt -- npx -y paydirt-mcp@latest
```

Restart Codex after adding the server. Then ask:

> Install Paydirt in this iOS app for regular feedback, trial cancellation, and subscription cancellation. Detect the subscription provider, connect every form to my Slack feedback channel, edit the app, build it, and give me an exact test path.

To remove the server later:

```bash
codex mcp remove paydirt
```

## Install in Claude Code

```bash
claude mcp add paydirt -- npx -y paydirt-mcp@latest
```

Other MCP hosts can launch the same stdio command:

```json
{
  "mcpServers": {
    "paydirt": {
      "command": "npx",
      "args": ["-y", "paydirt-mcp@latest"]
    }
  }
}
```

Requires Node.js 18 or newer.

## Authentication

Authentication is an explicit, headless-safe two-step flow:

1. The agent calls `paydirt_begin_setup`. It immediately receives an `authorization_url`, `session_id`, and exact `finish_arguments`. The MCP process never launches a browser, sleeps, or polls.
2. Open `authorization_url` in any browser and sign in to Paydirt.
3. The agent calls `paydirt_finish_setup` with the returned arguments. A pending call returns immediately; call it again only after authorization is complete.

`paydirt_setup` remains as a compatibility alias: call it without `session_id` to begin and with `session_id` to finish.

Credentials are saved locally at `~/.paydirt/credentials.json` with owner-only permissions. They are not written to an app repository or sent anywhere except `api.paydirt.ai`. For ephemeral environments, set `PAYDIRT_AUTH_TOKEN` instead.

## Natural agent workflows

### Add a form at an in-app action

Ask:

> Add a feedback form titled “Export Feedback” after a successful export and send it to #product-feedback.

The agent should use `paydirt_add_feedback_form`. It reuses an existing custom form with the same normalized title, preserves the requested placement, resolves Slack when possible, and returns the exact Swift presentation call. A remote form is not considered installed until the agent edits and builds the host app.

Supported triggers are user taps, successful in-app actions, screen appearance, and app-owned custom conditions.

### Install cancellation feedback

The agent inspects the app before setup and selects the existing subscription source of truth:

- Native StoreKit uses Paydirt's built-in StoreKit integration.
- RevenueCat and Superwall use host-app adapters, avoiding duplicate package dependencies.
- App-owned billing emits Paydirt's provider-independent cancellation event.
- Apps without subscriptions can install manual feedback alone.

If cancellation automation is blocked, the agent must still finish and build manual feedback and explain only the narrow provider blocker.

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

See [SUPPORT.md](SUPPORT.md) for support, [SECURITY.md](SECURITY.md) before reporting a vulnerability, and [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[MIT](LICENSE)
