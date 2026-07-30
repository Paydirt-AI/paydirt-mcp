---
name: install-paydirt
description: Install, configure, place, test, or inspect Paydirt feedback forms in an iOS app. Use for regular feedback, trial cancellation, subscription cancellation, Slack delivery, or raw feedback access.
---

# Install and operate Paydirt

Treat Paydirt as an agent-installed path from an iOS feedback moment to a durable conversation visible in Slack and coding agents.

When the user asks to install Paydirt:

1. Inspect the host repository before calling setup. Identify the app target, bundle ID, dependency manager, app entry point, subscription source of truth, product IDs, cancellation flow, and requested placement.
2. Preserve every existing host-app feedback form, button, screen, handler, destination, and side effect. Never replace, remove, repurpose, or reroute existing feedback behavior unless the user explicitly requests that exact change.
3. Use `paydirt_begin_setup` with the discovered app identity, requested use cases, and one subscription bridge when cancellation forms are requested: `storekit`, `revenuecat`, `superwall`, `custom`, or `none`.
4. Give the returned `authorization_url` to the user. Do not poll, sleep, or claim setup is finished while authorization is pending.
5. After the user authorizes, call `paydirt_finish_setup` with the exact returned `finish_arguments`.
6. Perform every returned `agent_action`: edit the host app, preserve its existing purchase stack and feedback behavior, configure the exact public SDK key and form IDs, connect and assign Slack, resolve dependencies, and build.
7. Use the returned `ios.install_verification` contract to add a DEBUG-only one-time app-ready trigger, launch the built app on an available simulator or connected development device, and leave the Paydirt form visibly open for the developer. Never submit it for them and never include the automatic trigger in release builds.
8. Connect Paydirt to the subscription code already working in the app. Inspect the APIs the installed version already uses, adapt the small host-source bridge or call Paydirt from the existing customer-info/cancellation path, and omit unavailable optional metadata rather than blocking installation.
9. If a requested cancellation bridge is blocked, preserve existing app behavior, report the exact provider error, and complete every unaffected requested form.

When the user requests a named form at a screen, button, lifecycle event, successful action, or custom condition, use `paydirt_add_feedback_form`. Preserve their title and placement exactly, reuse matching forms, edit the host app at that location, then build and verify it.

Raw questions and answers are the source of truth. Slack receives one message after the conversation finishes. An AI summary is optional and may only supplement the raw conversation. Feedback tools are read-only consumers and must not take product or coding action automatically.
