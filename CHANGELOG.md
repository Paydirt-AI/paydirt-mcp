# Changelog

All notable changes to Paydirt MCP are documented here.

## 2.1.4 - 2026-07-30

- Create or reuse an app-specific Slack feedback channel during OAuth by default.
- Assign every installed form to the default Slack channel automatically.
- Make trial and paid subscription cancellation the default cancellation pair.

## 2.1.3 - 2026-07-30

- Require every successful agent installation to build and launch the host app.
- Return an exact Debug-only one-time presentation call for immediate verification.
- Require the agent to leave the test form visibly open without submitting it for the developer.

## 2.1.2 - 2026-07-30

- Preserve existing host-app feedback behavior while installing requested forms.
- Connect cancellation forms to the StoreKit, RevenueCat, Superwall, or app-owned subscription code already working in the app.
- Adapt small host-source bridges to installed provider APIs and omit unavailable optional metadata rather than blocking installation.
- Clarify Superwall CustomerInfo bridge compatibility and strengthen placement, setup, and distribution tests.

## 2.1.1 - 2026-07-30

- Add official MCP Registry ownership and package metadata.
- Add a public Claude Code plugin marketplace with the Paydirt workflow and pinned MCP server.
- Add a validated OpenAI plugin candidate and explicit remote-HTTPS submission gate.

## 2.1.0 - 2026-07-30

- Add non-blocking `paydirt_begin_setup` and `paydirt_finish_setup` authentication tools for local, remote, and headless agents.
- Keep `paydirt_setup` as a two-call compatibility alias.
- Store credentials with owner-only file permissions.
- Add first-class Codex installation instructions and public repository metadata.
- Document agent placement, subscription-provider, Slack, and raw-feedback workflows.

## 2.0.0 - 2026-07-29

- Add StoreKit, RevenueCat, Superwall, custom billing, and no-subscription installation contracts.
- Add idempotent named feedback forms with screen and in-app-action placement contracts.
- Require host-app edits, builds, test paths, and verified Slack assignment for completed installation.
