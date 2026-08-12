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

When a public Paydirt remote MCP server is available, confirm one concise form plan before authorization. An explicit request naming the forms counts as confirmation. Otherwise, recommend three clear forms—Suggest a Feature in Settings, Trial Cancellation, and Subscription Cancellation—when subscriptions exist; otherwise explain that cancellation has no trigger and recommend Suggest a Feature. Call `paydirt_begin_setup` with `form_plan_confirmed: true`, the selected use cases, and placement; return its authorization URL and call `paydirt_finish_setup` only after authorization. Browser onboarding handles Google sign-in, app and form creation, and the delivery choice: Slack and coding agents (recommended), Slack only, or coding agents only. The browser discloses that either coding-agent choice includes a read-only daily 9:00 AM Paydirt brief. When Slack is selected, require OAuth, provision `#paydirt-suggest-a-feature` and `#paydirt-cancellations`, and assign the corresponding forms before completing setup. Respect the returned delivery preference and do not ask again unless the developer requests a change. Perform every returned host-app action, resolve dependencies, build, and follow `ios.install_verification` to leave the three-test setup check visibly open on a simulator or connected device. The developer personally submits Suggest a Feature, Trial Cancellation, and Subscription Cancellation. For Slack, require 3/3 verified deliveries to the expected channels. After all delivery tests pass, create the included daily task with `daily_brief.task_prompt` when the host supports native scheduling; otherwise report the limitation and provide the prompt without claiming a schedule exists. Slack-only delivery does not include the brief. Digests are read-only and never create coding tasks or edit the app. Agent response access is read-only and must never inject every response into every session or take automatic action. Never submit a test or include the automatic trigger in release builds. Preserve existing purchase and feedback behavior; use RevenueCat when installed and StoreKit otherwise.

For a named form at a screen or action, use `paydirt_add_feedback_form`, preserve the user's placement exactly, edit that location in the app, and build it. Remote form creation alone is not completion.

Raw questions and answers are authoritative. An AI summary may supplement them. Do not automatically take product or coding action from feedback.

If the remote MCP server is not connected, explain that this submission bundle is intentionally inactive until Paydirt deploys and verifies its public HTTPS MCP endpoint. Do not substitute or describe the npm stdio process as a remote endpoint.
