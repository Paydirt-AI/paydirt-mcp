# Paydirt for Claude Code

This plugin bundles Paydirt's iOS installation workflow and `paydirt-mcp@2.5.0`.

From Claude Code, add the public marketplace and install the plugin:

```text
/plugin marketplace add Paydirt-AI/paydirt-mcp
/plugin install paydirt@paydirt-plugins
/reload-plugins
```

Then say “Add Paydirt to this app.” Claude inspects the project and proposes
Subscription Cancellation, Trial Cancellation, and Suggest a Feature, with
responses in Slack and Claude Code, in one message. After you confirm, it
creates the forms, starts Slack in parallel, writes the SDK key into the
project, and builds and launches the app with the Debug setup check open.
Submit one test answer and Claude announces it as it lands. Existing feedback
screens and purchase flows are preserved, and you never paste a key.
