# Paydirt for Claude Code

This plugin bundles Paydirt's iOS installation workflow and `paydirt-mcp@2.1.1`.

From Claude Code, add the public marketplace and install the plugin:

```text
/plugin marketplace add Paydirt-AI/paydirt-mcp
/plugin install paydirt@paydirt-plugins
/reload-plugins
```

Then ask Claude to install Paydirt, add a named feedback form at an in-app action, connect the forms to Slack, build the iOS app, and provide a test path. Authentication begins with a URL returned by `paydirt_begin_setup`; the MCP server never launches a browser or blocks while waiting.
