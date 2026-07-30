---
name: install-paydirt
description: Install, configure, place, test, or inspect Paydirt feedback forms in an iOS app. Use for regular feedback, trial cancellation, subscription cancellation, Slack delivery, or raw feedback access.
---

# Install and operate Paydirt

Treat Paydirt as an agent-installed path from an iOS feedback moment to a durable conversation visible in Slack and coding agents.

When the user asks to install Paydirt:

1. Inspect the host repository before calling setup. Identify the app target, bundle ID, dependency manager, app entry point, subscription source of truth, product IDs, cancellation flow, and requested placement.
2. Use `paydirt_begin_setup` with the discovered app identity, use cases, and one subscription provider: `storekit`, `revenuecat`, `superwall`, `custom`, or `none`.
3. Give the returned `authorization_url` to the user. Do not poll, sleep, or claim setup is finished while authorization is pending.
4. After the user authorizes, call `paydirt_finish_setup` with the exact returned `finish_arguments`.
5. Perform every returned `agent_action`: edit the host app, preserve its existing purchase stack, configure the exact public SDK key and form IDs, connect and assign Slack, resolve dependencies, build, and provide an exact test path.
6. If automatic cancellation detection is blocked, finish and build manual feedback. Defer only the blocked provider integration and report its exact error.

When the user requests a named form at a screen, button, lifecycle event, successful action, or custom condition, use `paydirt_add_feedback_form`. Preserve their title and placement exactly, reuse matching forms, edit the host app at that location, then build and verify it.

Raw questions and answers are the source of truth. Slack receives one message after the conversation finishes. An AI summary is optional and may only supplement the raw conversation. Feedback tools are read-only consumers and must not take product or coding action automatically.
