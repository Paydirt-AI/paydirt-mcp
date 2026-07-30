# OpenAI plugin submission checklist

## Remote MCP gate

- [ ] Deploy a public Streamable HTTP MCP endpoint at `https://mcp.paydirt.ai/mcp`.
- [ ] Implement OAuth or another OpenAI-supported user authorization flow without embedding Paydirt user tokens in plugin files.
- [ ] Preserve the current setup, form, Slack, and read-only response contracts over HTTPS.
- [ ] Return correct MCP content types, validate `Origin`, apply rate limits, and publish a health/status path.
- [ ] Run an external MCP conformance and end-to-end test against production.

## Activate this bundle

- [ ] Copy `.mcp.example.json` to `.mcp.json` only after the production endpoint passes the gate above.
- [ ] Add `"mcpServers": "./.mcp.json"` to `.codex-plugin/plugin.json`.
- [ ] Run the OpenAI plugin validator and inspect the complete archive for secrets.
- [ ] Confirm `https://www.paydirt.ai/privacy` and `https://www.paydirt.ai/terms` are public and accurate for MCP, Slack, transcription, and feedback data.
- [ ] Add production icons/screenshots and reference only files included in the bundle.

## Submission evidence

- [ ] Record the tested endpoint, auth flow, tool inventory, test account path, privacy URL, terms URL, support URL, and security contact.
- [ ] Demonstrate that raw responses are read-only to agents and that no action is taken automatically.
- [ ] Demonstrate one StoreKit, RevenueCat, Superwall, and manual-feedback installation.
- [ ] Submit only after every checkbox above is complete; do not represent the npm stdio package as a hosted remote MCP server.
