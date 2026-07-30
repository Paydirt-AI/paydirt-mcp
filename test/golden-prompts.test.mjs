import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function toolNames() {
  const client = new Client(
    { name: 'paydirt-golden-test', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'] });
  await client.connect(transport);
  try {
    return new Set((await client.listTools()).tools.map((tool) => tool.name));
  } finally {
    await client.close();
  }
}

test('golden routing corpus covers target prompt families and only references public tools', async () => {
  const corpus = JSON.parse(
    await readFile(new URL('../evals/tool-selection-golden.json', import.meta.url), 'utf8')
  );
  const tools = await toolNames();
  const ids = new Set();
  const categories = new Set(corpus.cases.map((item) => item.category));

  assert.deepEqual(
    categories,
    new Set(['direct', 'indirect', 'placement', 'provider-specific', 'negative'])
  );
  assert.ok(corpus.cases.length >= 20);

  for (const item of corpus.cases) {
    assert.ok(item.id && !ids.has(item.id), `golden case IDs must be unique: ${item.id}`);
    ids.add(item.id);
    assert.ok(typeof item.prompt === 'string' && item.prompt.length >= 12);
    assert.ok(Array.isArray(item.expected_tools));
    for (const tool of item.expected_tools) {
      assert.ok(tools.has(tool), `${item.id} references unknown tool ${tool}`);
    }
    if (item.category === 'negative') {
      assert.deepEqual(item.expected_tools, [], `${item.id} must not route to Paydirt`);
      assert.ok(item.reason);
    }
  }
});

test('provider golden cases cover all supported subscription sources', async () => {
  const corpus = JSON.parse(
    await readFile(new URL('../evals/tool-selection-golden.json', import.meta.url), 'utf8')
  );
  const providers = new Set(
    corpus.cases.filter((item) => item.category === 'provider-specific').map((item) => item.provider)
  );
  assert.deepEqual(providers, new Set(['revenuecat', 'storekit', 'superwall', 'custom', 'none']));
});
