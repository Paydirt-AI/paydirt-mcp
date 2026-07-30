---
name: install-paydirt
description: Install, configure, place, test, or inspect Paydirt feedback forms in an iOS app. Use for regular feedback, trial cancellation, subscription cancellation, Slack delivery, or raw feedback access.
---

# Install and operate Paydirt

Inspect the iOS host before setup. Determine its bundle ID, app entry point, dependency manager, subscription source of truth, product IDs, cancellation flow, and requested form placement.

When a public Paydirt remote MCP server is available, begin with `paydirt_begin_setup`, return its authorization URL to the user, and call `paydirt_finish_setup` only after authorization. Perform every returned host-app action: edit the project, preserve its purchase stack, configure the exact forms, connect Slack, resolve dependencies, build, and provide an exact test path.

For a named form at a screen or action, use `paydirt_add_feedback_form`, preserve the user's placement exactly, edit that location in the app, and build it. Remote form creation alone is not completion.

Raw questions and answers are authoritative. An AI summary may supplement them. Do not automatically take product or coding action from feedback.

If the remote MCP server is not connected, explain that this submission bundle is intentionally inactive until Paydirt deploys and verifies its public HTTPS MCP endpoint. Do not substitute or describe the npm stdio process as a remote endpoint.
