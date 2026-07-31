---
name: install-paydirt
description: Install, configure, place, test, or inspect Paydirt feedback forms in an iOS app. Use for regular feedback, trial cancellation, subscription cancellation, Slack delivery, or raw feedback access.
---

# Install and operate Paydirt

Treat Paydirt as an agent-installed path from an iOS feedback moment to a durable conversation visible in Slack and coding agents.

When the user asks to install Paydirt:

1. Inspect the host repository before calling setup. Identify the app target, bundle ID, dependency manager, app entry point, subscription source of truth, product IDs, cancellation flow, and requested placement.
2. Preserve every existing host-app feedback form, button, screen, handler, destination, and side effect. Never replace, remove, repurpose, or reroute existing feedback behavior unless the user explicitly requests that exact change.
3. Use `paydirt_begin_setup` with the discovered app identity and requested use cases. Select RevenueCat when it is already installed; otherwise select StoreKit for ordinary App Store subscriptions, including apps where Superwall only presents paywalls.
4. Give the returned `authorization_url` to the user. This one browser flow handles Google sign-in, app/form creation, Slack authorization, channel creation, and form assignment. Do not poll, sleep, or claim setup is finished while authorization is pending.
5. After the user authorizes, call `paydirt_finish_setup` with the exact returned `finish_arguments`.
6. Perform every returned `agent_action`: edit the host app, preserve its existing purchase stack and feedback behavior, configure the exact public SDK key and form IDs, verify Slack once, resolve dependencies, and build. Generic installation includes regular feedback plus both trial and paid subscription cancellation. Do not start a second Slack OAuth flow after setup.
7. Use the returned `ios.install_verification` contract to add a DEBUG-only one-time app-ready trigger, launch the built app on an available simulator or connected development device, and leave the Paydirt form visibly open for the developer. Never submit it for them and never include the automatic trigger in release builds.
8. Connect Paydirt to the subscription code already working in the app. Add any small integration source yourself and use the familiar Paydirt setup API; do not ask the developer to copy an adapter or upgrade RevenueCat. Omit unavailable optional metadata rather than blocking installation.
9. If a requested cancellation bridge is blocked, preserve existing app behavior, report the exact provider error, and complete every unaffected requested form.

When the user requests a named form at a screen, button, lifecycle event, successful action, or custom condition, use `paydirt_add_feedback_form`. Preserve their title and placement exactly, reuse matching forms, edit the host app at that location, then build and verify it.

Raw questions and answers are the source of truth. Slack receives one message after the conversation finishes. An AI summary is optional and may only supplement the raw conversation. Feedback tools are read-only consumers and must not take product or coding action automatically.
