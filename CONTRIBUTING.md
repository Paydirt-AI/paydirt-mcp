# Contributing

Thanks for helping improve Paydirt MCP.

1. Open an issue describing the user or agent workflow being improved.
2. Create a focused branch and avoid committing credentials or customer feedback.
3. Run `npm ci`, `npm test`, and `npm pack --dry-run`.
4. Include tests for changed tool contracts or setup behavior.
5. Open a pull request describing the behavior before and after the change.

Tool descriptions are part of the product interface. Keep them explicit about required host-app edits, builds, Slack verification, and the fact that feedback tools are read-only.

## Releases

The npm package version and Git tag must match exactly (`2.1.0` is tagged `v2.1.0`). The manual publish workflow accepts only a tag matching `package.json` and uses npm trusted publishing with provenance. A repository administrator must first configure `Paydirt-AI/paydirt-mcp` and workflow `publish.yml` as a trusted publisher for the `paydirt-mcp` package on npm, then dispatch the workflow from the version tag. Do not store an npm token in GitHub.

Use GitHub's [private vulnerability reporting](https://github.com/Paydirt-AI/paydirt-mcp/security/advisories/new) instead of an issue for vulnerabilities.
