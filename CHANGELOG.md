# Changelog

All notable changes to Paydirt MCP are documented here.

## 2.1.6 - 2026-07-31

- Combined Google and Slack authorization into the single browser setup gate.
- Updated generated installations to Paydirt iOS 2.0.2.
- Restored the familiar RevenueCat setup call and removed adapter terminology
  from the developer-facing flow.
- Made RevenueCat the automatic first choice when present and native StoreKit
  the default for other App Store subscription apps.
- Updated the official MCP SDK runtime and locked transitive dependencies with
  zero production advisories.

## 2.1.5 - 2026-07-30

- Create a new `#paydirt-cancellation-feedback` Slack channel by default.
- Use a numbered channel name rather than reusing an unrelated existing channel.

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
