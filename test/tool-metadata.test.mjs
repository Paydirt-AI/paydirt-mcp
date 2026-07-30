import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function listedTools() {
  const client = new Client(
    { name: 'paydirt-metadata-test', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    stderr: 'pipe',
  });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

test('every tool exposes model-usable descriptions, unique titles, and explicit safety hints', async () => {
  const tools = await listedTools();
  assert.ok(tools.length >= 22, 'backward-compatible tool surface must not shrink');

  const titles = new Set();
  for (const tool of tools) {
    assert.match(tool.description || '', /Use this when/i, `${tool.name} needs selection guidance`);
    assert.ok(tool.annotations?.title, `${tool.name} needs a human-readable title`);
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} needs readOnlyHint`);
    assert.equal(typeof tool.annotations?.destructiveHint, 'boolean', `${tool.name} needs destructiveHint`);
    assert.equal(typeof tool.annotations?.openWorldHint, 'boolean', `${tool.name} needs openWorldHint`);
    assert.equal(titles.has(tool.annotations.title), false, `${tool.name} title must be unique`);
    titles.add(tool.annotations.title);
  }
});

test('safety annotations distinguish reads, additive writes, overwrites, and deletion', async () => {
  const tools = new Map((await listedTools()).map((tool) => [tool.name, tool]));

  assert.equal(tools.get('paydirt_get_responses').annotations.readOnlyHint, true);
  assert.equal(tools.get('paydirt_create_form').annotations.destructiveHint, false);
  assert.equal(tools.get('paydirt_add_feedback_form').annotations.idempotentHint, true);
  assert.equal(tools.get('paydirt_add_feedback_form').annotations.destructiveHint, true);
  assert.equal(tools.get('paydirt_update_form').annotations.destructiveHint, true);
  assert.equal(tools.get('paydirt_delete_form').annotations.destructiveHint, true);
  assert.equal(tools.get('paydirt_connect_slack').annotations.readOnlyHint, true);
});

test('object-shaped results publish output schemas while array roots remain backward compatible', async () => {
  const tools = new Map((await listedTools()).map((tool) => [tool.name, tool]));
  const schemaTools = [
    'paydirt_begin_setup',
    'paydirt_add_feedback_form',
    'paydirt_health_check',
    'paydirt_connect_slack',
    'paydirt_slack_status',
    'paydirt_ask',
  ];

  for (const name of schemaTools) {
    assert.equal(tools.get(name).outputSchema?.type, 'object', `${name} needs an object output schema`);
    assert.ok(tools.get(name).outputSchema.required?.length > 0, `${name} needs required output fields`);
  }
  assert.equal(tools.get('paydirt_list_apps').outputSchema, undefined);
  assert.equal(tools.get('paydirt_get_responses').outputSchema, undefined);
});
