# Paydirt for Claude Code

This plugin bundles Paydirt's iOS installation workflow and `paydirt-mcp@2.3.0`.

From Claude Code, add the public marketplace and install the plugin:

```text
/plugin marketplace add Paydirt-AI/paydirt-mcp
/plugin install paydirt@paydirt-plugins
/reload-plugins
```

Then say “Add Paydirt and show me it working.” Claude confirms cancellation and
Suggest a Feature choices, browser onboarding asks whether delivery should be
Slack and coding agents (recommended), Slack only, or coding agents only, and
then Claude builds the iOS app and leaves the three-test setup check visibly open.
Existing feedback UI is preserved unless you
explicitly request a change. Authentication begins with a URL returned by
`paydirt_begin_setup`; the MCP server never launches a browser or blocks while waiting.
