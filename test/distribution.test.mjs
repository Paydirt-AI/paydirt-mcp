import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const json = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));

test('distribution metadata validates at 2.5.2 with the hosted remote listed', async () => {
  const packageJson = await json('package.json');
  assert.equal(packageJson.version, '2.5.2');
  assert.equal((await json('.mcp/server.json')).version, '2.5.2');
  assert.deepEqual((await json('plugins/paydirt/.mcp.json')).paydirt.args.at(-1), 'paydirt-mcp@2.5.2');
  assert.equal((await json('plugins/paydirt/.claude-plugin/plugin.json')).version, '2.5.2');

  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/validate-distribution.mjs'], { cwd: root });
  assert.match(stdout, /internally consistent/);
});
