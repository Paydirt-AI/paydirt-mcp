# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability or include credentials, customer feedback, access tokens, API keys, or private app source in an issue.

Use GitHub's [private vulnerability reporting](https://github.com/Paydirt-AI/paydirt-mcp/security/advisories/new) with:

- the affected package version;
- a concise reproduction;
- the security impact; and
- any suggested mitigation.

We will coordinate disclosure after a fix is available. If private vulnerability reporting is unavailable, use the support link at [paydirt.ai](https://www.paydirt.ai) without including secrets in an initial message.

## Credential handling

Paydirt MCP stores its user credential in `~/.paydirt/credentials.json` with owner-only file permissions. It never intentionally writes credentials into the host iOS repository. The public iOS SDK key returned during setup is designed for inclusion in an app; the Paydirt user auth token is not.

Do not commit `.paydirt`, `credentials.json`, `.env`, npm tokens, Slack tokens, or Paydirt user auth tokens. Rotate a token immediately if it is exposed.

## Supported versions

Security fixes are applied to the current npm release. Upgrade with `npx -y paydirt-mcp@latest` or restart an MCP host configured with that command.
