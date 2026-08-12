import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function json(path) {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
}

const packageJson = await json('package.json');
const registry = await json('.mcp/server.json');
const claudeMarketplace = await json('.claude-plugin/marketplace.json');
const claudePlugin = await json('plugins/paydirt/.claude-plugin/plugin.json');
const claudeMcp = await json('plugins/paydirt/.mcp.json');
const openAiMarketplace = await json('distribution/openai-plugin/.agents/plugins/marketplace.json');
const openAiPlugin = await json('distribution/openai-plugin/plugins/paydirt/.codex-plugin/plugin.json');
const openAiMcpExample = await json('distribution/openai-plugin/plugins/paydirt/.mcp.example.json');

assert.equal(packageJson.mcpName, registry.name, 'npm mcpName must match MCP Registry name');
assert.equal(packageJson.version, registry.version, 'npm and MCP Registry versions must match');
assert.equal(registry.packages.length, 1);
assert.equal(registry.packages[0].registryType, 'npm');
assert.equal(registry.packages[0].identifier, packageJson.name);
assert.equal(registry.packages[0].version, packageJson.version);
assert.equal(registry.packages[0].transport.type, 'stdio');
assert.equal(registry.remotes, undefined, 'stdio package must not claim a remote transport');

const claudeEntry = claudeMarketplace.plugins.find((plugin) => plugin.name === 'paydirt');
assert.ok(claudeEntry, 'Claude marketplace must include Paydirt');
assert.equal(claudeEntry.version, claudePlugin.version);
assert.equal(claudePlugin.version, packageJson.version);
assert.deepEqual(claudeMcp.paydirt.args, ['--yes', '--prefer-online', `paydirt-mcp@${packageJson.version}`]);

assert.equal(openAiPlugin.name, 'paydirt');
assert.equal(openAiPlugin.version, packageJson.version);
assert.equal(openAiPlugin.mcpServers, undefined, 'OpenAI candidate must stay inactive before remote MCP launch');
assert.equal(openAiMcpExample.mcpServers.paydirt.type, 'http');
assert.match(openAiMcpExample.mcpServers.paydirt.url, /^https:\/\//);

const openAiEntry = openAiMarketplace.plugins.find((plugin) => plugin.name === 'paydirt');
assert.ok(openAiEntry, 'OpenAI public marketplace metadata must include Paydirt');
assert.equal(openAiEntry.policy.installation, 'AVAILABLE');
assert.equal(openAiEntry.policy.authentication, 'ON_INSTALL');
assert.equal(openAiEntry.category, 'Productivity');

console.log('Distribution metadata is internally consistent.');
