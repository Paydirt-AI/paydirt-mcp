import { readFileSync } from 'node:fs';

type PackageMetadata = { version?: unknown };

const packageMetadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as PackageMetadata;

if (typeof packageMetadata.version !== 'string' || !packageMetadata.version) {
  throw new Error('Paydirt MCP package version is missing');
}

export const PAYDIRT_MCP_VERSION = packageMetadata.version;
export const PAYDIRT_MCP_USER_AGENT = `paydirt-mcp/${PAYDIRT_MCP_VERSION}`;
