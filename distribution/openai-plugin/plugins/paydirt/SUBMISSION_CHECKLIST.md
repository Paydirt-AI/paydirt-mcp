# OpenAI plugin submission checklist

## Remote MCP gate

- [x] Implement and locally test a Streamable HTTP entry point that preserves the stdio tool surface.
- [x] Isolate hosted authorization by OAuth client and Paydirt account; never use the stdio credential file in hosted mode.
- [x] Add local Host, Origin, content negotiation, routing-header, rate-limit, session cleanup, and health tests.
- [x] Implement standards-based OAuth 2.1 discovery, DCR, PKCE S256, resource binding, short access tokens, refresh rotation, revocation, and restart-safe grants without passing MCP bearer tokens to the Paydirt API.
- [ ] Deploy a public Streamable HTTP MCP endpoint at `https://mcp.paydirt.ai/mcp`.
- [ ] Apply the OAuth Supabase migration and deploy the matching API and dashboard approval flow.
- [ ] Confirm the single Google + Slack OAuth approval flow in every target host.
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
