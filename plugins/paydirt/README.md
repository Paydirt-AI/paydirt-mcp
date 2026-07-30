# Paydirt for Claude Code

This plugin bundles Paydirt's iOS installation workflow and `paydirt-mcp@2.1.5`.

From Claude Code, add the public marketplace and install the plugin:

```text
/plugin marketplace add Paydirt-AI/paydirt-mcp
/plugin install paydirt@paydirt-plugins
/reload-plugins
```

Then ask Claude to install the Paydirt feedback, contextual, trial cancellation,
or subscription cancellation forms you need, connect them to Slack, build the
iOS app, and provide a test path. Existing feedback UI is preserved unless you
explicitly request a change. Authentication begins with a URL returned by
`paydirt_begin_setup`; the MCP server never launches a browser or blocks while waiting.
