# Hosted Paydirt MCP

This package supports both transports without changing the Paydirt tool surface:

- `npm start` starts the existing local stdio server.
- `npm run start:hosted` starts Streamable HTTP at `/mcp` and health reporting at `/healthz`.

The production URL is `https://mcp.paydirt.ai/mcp`.

## Authorization model

The hosted server is an OAuth 2.1 authorization server and protected resource. It publishes RFC 9728 protected-resource metadata, authorization-server metadata, Dynamic Client Registration, authorization, token, refresh, and revocation endpoints. Public clients must use PKCE S256 and the exact `https://mcp.paydirt.ai/mcp` resource indicator.

The authorization page reuses Paydirt's existing setup for Google sign-in plus app and default-form preparation. Browser onboarding asks the developer to choose Slack, coding agents, or both. When Slack is selected, the developer authorizes their workspace and chooses channels before installation resumes. Only completed Q&A is delivered. After the browser flow, the client receives a one-hour opaque access token and a rotated 30-day refresh token. Only token hashes and account/app bindings are stored in Supabase. Reuse of a rotated refresh token revokes its full token family.

The MCP bearer token is never passed to the Paydirt product API. Each authenticated MCP request is introspected by the API, which returns a separate 15-minute API JWT bound to the same user and app. MCP reconnects and process restarts therefore do not require another Google or Slack authorization while the OAuth grant remains valid.

The stdio server is unchanged and continues to use the existing owner-only `~/.paydirt/credentials.json` file.

## Required production configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | platform supplied | `3002` | HTTP listener port |
| `HOST` | no | `0.0.0.0` | HTTP bind address |
| `PAYDIRT_API_URL` | no | `https://api.paydirt.ai` | Paydirt API origin |
| `MCP_OAUTH_INTERNAL_SECRET` | yes | none | Shared high-entropy secret for hosted-MCP-to-API OAuth calls |
| `MCP_ISSUER_URL` | no | `https://mcp.paydirt.ai` | OAuth authorization-server issuer |
| `MCP_RESOURCE_URL` | no | `https://mcp.paydirt.ai/mcp` | Exact OAuth resource identifier |
| `MCP_ALLOWED_HOSTS` | recommended | `mcp.paydirt.ai,localhost,127.0.0.1,[::1]` | DNS-rebinding/Host allowlist |
| `MCP_ALLOWED_ORIGINS` | recommended | ChatGPT, Claude, and Paydirt web origins | Browser Origin allowlist |
| `MCP_REQUESTS_PER_MINUTE` | no | `120` | Per-client request limit |
| `MCP_INITIALIZE_REQUESTS_PER_MINUTE` | no | `20` | Per-client session creation limit |
| `MCP_SESSION_TTL_SECONDS` | no | `86400` | Inactive session lifetime |

The API deployment must use the same `MCP_OAUTH_INTERNAL_SECRET` and `MCP_RESOURCE_URL`, plus its existing `JWT_SECRET`, Supabase service credentials, and `DASHBOARD_URL=https://www.paydirt.ai`. Apply `202607310001_mcp_oauth.sql` before enabling the endpoint.

Terminate TLS at the hosting platform and point `mcp.paydirt.ai` to it. Do not place Paydirt user JWTs, Slack credentials, or Google credentials in the MCP service.

## Scaling and release gate

The first hosted release intentionally uses stateful in-memory MCP transport sessions and must run as one replica unless the platform supplies sticky routing. OAuth clients, grants, and hashed tokens are durable in Supabase. A process restart requires a transport reconnect, but not another Google/Slack authorization while the access or refresh token is valid.

Before publishing the remote Registry entry or activating the OpenAI plugin candidate:

1. Apply the OAuth migration, then deploy the API and dashboard changes.
2. Configure the shared internal secret and exact issuer/resource URLs in production.
3. Deploy one MCP replica behind HTTPS at `mcp.paydirt.ai`.
4. Verify health, protected-resource metadata, authorization-server metadata, DCR, PKCE, refresh rotation, revocation, and an external initialize/list-tools/setup request.
5. Confirm invalid Host and Origin requests are rejected and production rate limits are visible.
6. Run the full test suite and an external conformance client against production.
7. Only then add the `remotes` Registry entry and activate the plugin `.mcp.json`.
