---
name: install-paydirt
description: Install, configure, place, test, or inspect Paydirt feedback forms in an iOS app. Use for regular feedback, trial cancellation, subscription cancellation, Slack delivery, or raw feedback access.
---

# Install and operate Paydirt

Inspect the iOS host before setup. Determine its bundle ID, app entry point, dependency manager, subscription source of truth, product IDs, cancellation flow, and requested form placement.

Preserve every existing host-app feedback form, button, screen, handler,
destination, and side effect. Never replace, remove, repurpose, or reroute
existing feedback behavior unless the user explicitly requests that exact
change.

When a public Paydirt remote MCP server is available, begin with `paydirt_begin_setup`, return its authorization URL to the user, and call `paydirt_finish_setup` only after authorization. That single browser flow handles Google sign-in, app and form creation, Slack authorization, channel creation, and form assignment. Generic installation includes regular feedback plus both trial and paid subscription cancellation. Perform every returned host-app action: edit the project, preserve its purchase stack and feedback behavior, configure the exact forms, verify Slack once without starting a second OAuth flow, resolve dependencies, and build. Then follow `ios.install_verification`: add a DEBUG-only one-time app-ready trigger, launch the app on an available simulator or connected development device, and leave the Paydirt form visibly open for the developer. Never submit it for them or include the automatic trigger in release builds. Use RevenueCat when already installed; otherwise use StoreKit for App Store subscriptions, including apps where Superwall only presents paywalls. Add any small compatibility source yourself and use the familiar Paydirt setup API; never ask the developer to copy an adapter or upgrade RevenueCat.

For a named form at a screen or action, use `paydirt_add_feedback_form`, preserve the user's placement exactly, edit that location in the app, and build it. Remote form creation alone is not completion.

Raw questions and answers are authoritative. An AI summary may supplement them. Do not automatically take product or coding action from feedback.

If the remote MCP server is not connected, explain that this submission bundle is intentionally inactive until Paydirt deploys and verifies its public HTTPS MCP endpoint. Do not substitute or describe the npm stdio process as a remote endpoint.
