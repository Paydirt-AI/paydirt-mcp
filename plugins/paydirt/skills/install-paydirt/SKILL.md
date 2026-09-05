---
name: install-paydirt
description: Install, configure, place, test, or inspect Paydirt voice feedback forms in an iOS app. Use for regular feedback, trial cancellation, subscription cancellation, Slack delivery, or raw feedback access.
---

# Install and operate Paydirt

Treat Paydirt as an agent-installed path from an iOS feedback moment to a durable conversation visible in Slack and coding agents.

When the user asks to install Paydirt:

1. Inspect the host repository before calling setup. Identify the app target, bundle ID, dependency manager, app entry point, subscription source of truth, product IDs, cancellation flow, and requested placement.
2. Preserve every existing host-app feedback form, button, screen, handler, destination, and side effect. Never replace, remove, repurpose, or reroute existing feedback behavior unless the user explicitly requests that exact change.
3. Confirm one concise form plan before authorization. An explicit request naming the forms counts as confirmation. Otherwise, when subscriptions exist, recommend three clear forms—Suggest a Feature in Settings, Trial Cancellation, and Subscription Cancellation—with Add all three, Add both cancellation forms, and Customize choices. When subscriptions do not exist, explain that cancellation has no real trigger and recommend Suggest a Feature. Set `form_plan_confirmed: true` only after the plan is explicit or the developer answers.
4. Use `paydirt_begin_setup` with the discovered app identity, confirmed use cases, and confirmed feature placement. Select RevenueCat when it is already installed; otherwise select StoreKit for ordinary App Store subscriptions, including apps where Superwall only presents paywalls.
5. Give the returned `authorization_url` to the user. This browser flow handles Google sign-in, app and form creation, and the required delivery choice: Slack and coding agents (recommended), Slack only, or coding agents only. When Slack is selected, authorize the app owner’s chosen workspace, let them select channels, and verify every requested form assignment before completing setup. Do not poll, sleep, or claim setup is finished while authorization is pending.
6. After the user authorizes, call `paydirt_finish_setup` with the exact returned `finish_arguments`.
7. Perform every returned `agent_action`: edit the host app, preserve its existing purchase stack and feedback behavior, configure the exact public SDK key and form IDs, resolve dependencies, and build.
8. Use the returned `ios.install_verification` contract to add a DEBUG-only one-time app-ready trigger, launch the built app on an available simulator or connected development device, and leave the Paydirt setup check visibly open. The developer personally submits every requested form. For Slack delivery, completion requires every requested test to reach its selected channel. Separately verify actual trial and paid cancellation triggers; a manually opened test form does not prove cancellation detection. Never submit a test for them and never include the automatic trigger in release builds.
9. Respect the delivery preference returned by setup; do not ask again unless the developer requests a change. When Slack was selected, verify the selected channels and every requested form assignment. Agent access is read-only: do not inject every response into every session or take automatic action.
10. Connect Paydirt to the subscription code already working in the app. Add any small integration source yourself and use the familiar Paydirt setup API; do not ask the developer to copy an adapter or upgrade RevenueCat. Omit unavailable optional metadata rather than blocking installation.
11. If a requested cancellation bridge is blocked, preserve existing app behavior, report the exact provider error, and complete every unaffected requested form.
12. The browser must disclose that selecting Slack and coding agents or coding agents only includes a read-only daily 9:00 AM Paydirt brief. After every required delivery test passes, create that scheduled task with `daily_brief.task_prompt` when the host exposes native scheduling and confirm its local run time. Otherwise provide the prompt and report the scheduling limitation without claiming a schedule exists. A digest reports counts and highlights, including an explicit zero-feedback result, and never creates coding tasks or edits the app automatically. Slack-only delivery does not include the daily brief.

When the user requests a named form at a screen, button, lifecycle event, successful action, or custom condition, use `paydirt_add_feedback_form`. Preserve their title and placement exactly, reuse matching forms, edit the host app at that location, then build and verify it.

Raw questions and answers are the source of truth. Slack receives one message after the conversation finishes. An AI summary is optional and may only supplement the raw conversation. Feedback tools are read-only consumers and must not take product or coding action automatically.

Only completed Q&A is delivered. Never send cancellation-only notices, empty responses, or drafts to Slack.
