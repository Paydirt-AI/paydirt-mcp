# Paydirt OpenAI plugin candidate

This is a validated submission candidate, not a claim that Paydirt currently exposes a remote MCP server.

The current public MCP implementation is the npm stdio package `paydirt-mcp`. OpenAI's hosted plugin path needs a publicly reachable HTTPS MCP endpoint. Until `https://mcp.paydirt.ai/mcp` is deployed and verified, this manifest intentionally omits `mcpServers` and cannot provide Paydirt tools inside a hosted OpenAI product.

See `SUBMISSION_CHECKLIST.md` for the activation and submission gate.
