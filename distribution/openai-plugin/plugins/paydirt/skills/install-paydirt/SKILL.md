---
name: install-paydirt
description: Add Paydirt voice feedback to an iOS app (Subscription Cancellation, Trial Cancellation, Suggest a Feature), show it running in the app, route responses to Slack and the coding agent, and read raw feedback. Use when the user says "add Paydirt" or asks for cancellation feedback, feature suggestions, or Paydirt responses.
---

# Add Paydirt to an iOS app

The human signs in once in the browser. Everything else happens here, in chat. Never ask the human for API keys, tokens, or credentials. You write the SDK key into the project yourself.

## 1. Inspect, then propose in ONE message

Inspect the project before calling any Paydirt tool: the app target, bundle ID, dependency manager, app entry point, subscription source of truth (RevenueCat, StoreKit, Superwall paywalls, custom), product IDs, and the file where the real cancel flow lives. Note every existing feedback screen and purchase flow; you will preserve all of them.

Then send one message and wait for the reply. Create nothing before the human confirms.

With subscriptions and a cancel flow:

> I found your StoreKit subscriptions and the real cancel flow in `Settings/ManageSubscriptionView.swift`. I recommend three starting forms: Subscription Cancellation, Trial Cancellation, and Suggest a Feature (in Settings). Responses go to Slack and here in Claude Code. Reply "yes" to set this up, or tell me Slack only, here only, or which form to drop. Nothing is created until you confirm.

Without subscriptions or a cancel flow:

> I didn't find subscriptions or a cancel flow, so cancellation feedback has nothing to trigger it yet. I recommend Suggest a Feature (in Settings). Responses go to Slack and here in Claude Code. Reply "yes" to set this up, or tell me Slack only or here only. Nothing is created until you confirm.

Use the real provider, file, and agent name. A plain "yes" accepts the recommended forms and the destinations `["slack", "claude-code"]` (use `"codex"` in Codex). The human may pick Slack only, here only, or drop any form. `paydirt_begin_setup` without `form_plan_confirmed` returns this message for you if you need it.

## 2. Create the app and forms, save delivery, start Slack

Right after the human confirms:

1. Call `paydirt_begin_setup` with `form_plan_confirmed: true`, the confirmed `use_cases`, `destinations`, `app_name`, `bundle_id`, `subscription_provider`, `subscription_product_ids`, `feature_placement`, and `cancel_flow_file`.
   - Hosted connection (`https://mcp.paydirt.ai/mcp`): this creates or reuses the app and forms right away and returns the installation contract.
   - Local stdio server: it returns `authorization_url`. Give it to the human; that page only signs in. Then call `paydirt_finish_setup` with `finish_arguments`. Do not poll or sleep while they sign in.
2. `destinations` saves delivery. If you did not pass them, call `paydirt_set_delivery`. Setup returns `delivery_selection_required`, never a silent default, when no destination is saved. In that case ask its `question` exactly.
3. If Slack was chosen and the contract says it is not connected, call `paydirt_connect_slack` now and share the link: "While I build, connect Slack: <link>". Do not wait for Slack.

## 3. Live demo first

Without waiting for Slack, perform every `agent_action` in order, posting short progress lines ("Adding Paydirt…", "Building…", "Launching…"):

- Install Paydirt 2.2.0 or newer in the project's existing dependency style.
- Write the public SDK key into the project yourself using `ios.configuration`. Add `NSMicrophoneUsageDescription` if missing.
- Wire `ios.subscription` to the subscription code already working in the app. Use RevenueCat when installed; otherwise use native StoreKit, including apps where Superwall only presents paywalls. Add any small bridge source yourself. Omit unavailable optional metadata rather than blocking.
- Place Suggest a Feature at the confirmed location.
- Place `ios.install_verification.app_ready_body_snippet` in a safe app-ready lifecycle body. This one-time DEBUG-only trigger opens the Paydirt setup check automatically on first launch, with no navigation needed.
- Resolve dependencies, build, and launch on a simulator or connected device. Leave the setup check visibly open.

Preserve every existing feedback form, button, screen, handler, and destination, and every purchase, paywall, and subscription flow. Never replace, remove, or reroute them unless the human asks for that exact change. If a cancellation bridge cannot compile, report the exact provider error, keep the existing behavior, and finish the unaffected forms. Never submit a test for the human, and never include the automatic trigger in release builds.

## 4. Slack routing in chat

After launch, if Slack was chosen, call `paydirt_slack_status`. Once connected, call `paydirt_list_slack_channels` and propose routing in chat, for example "Cancellations → #churn, feature ideas → #product (or both to one channel)". After the human confirms, save it with `paydirt_set_slack_channels` and verify with `paydirt_slack_status`. If Slack is still not connected, share the link again and continue. Use `paydirt_set_form_channel` only for a single custom form.

## 5. The first response

Ask the human to submit one test in the open setup check, by voice or text. Immediately call `paydirt_wait_for_response` with the app ID and `since` set to the launch time. It is the only bounded wait (default 60 seconds, max 90). When it returns `received`, announce it: "Your first response just landed: '…'". On `timed_out`, ask whether they submitted, then call it again. Installation is complete when the setup check shows every requested form verified. Form verification does not prove the real cancellation trigger, so verify the trial and paid triggers separately with the subscription provider.

## 6. Daily brief

For delivery that includes the coding agent, offer a read-only daily 9:00 AM brief. If accepted and the host has native scheduling, create it with `daily_brief.task_prompt`; otherwise give the prompt and say scheduling is unavailable. Slack-only delivery has no brief.

Finish by reporting the files changed, the build and launch commands and results, the delivery route, the enabled forms, and a repeatable manual test path.

## Later requests

- A named form at a screen, button, or successful action: use `paydirt_add_feedback_form`, keep the title and placement exactly, edit that location in the app, and build it. Creating the remote form alone is not completion.
- Changing delivery: use `paydirt_set_delivery`.
- Reading feedback: use `paydirt_get_responses`, `paydirt_get_feedback_digest`, `paydirt_get_summary`, or `paydirt_ask`.

Raw questions and answers are the source of truth; an AI summary only supplements them. Only completed Q&A is delivered, never cancellation-only notices or drafts. Feedback access is read-only: never inject every response into every session, create tasks, or change code from feedback automatically.

If the Paydirt tools are not available, ask the human to connect the server (`claude mcp add --transport http paydirt https://mcp.paydirt.ai/mcp`, `codex mcp add paydirt --url https://mcp.paydirt.ai/mcp`, or `npx -y paydirt-mcp` as a fallback) rather than describing a connection that does not exist.
