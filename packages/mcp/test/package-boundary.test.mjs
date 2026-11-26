import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, npm_config_update_notifier: 'false' }
  });
}

test('fresh workspace install keeps Hono out of the root tree and MCP stdio working', async t => {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const mcpPackage = JSON.parse(fs.readFileSync(path.join(root, 'packages/mcp/package.json'), 'utf8'));
  assert.deepEqual(rootPackage.bin, { 'cloudflare-arch-sim': 'cli.mjs' });
  assert.equal(rootPackage.dependencies?.['@modelcontextprotocol/sdk'], undefined);
  assert.equal(rootPackage.dependencies?.zod, undefined);
  assert.equal(rootPackage.overrides?.['@modelcontextprotocol/sdk'], undefined);
  assert.equal(mcpPackage.dependencies['@modelcontextprotocol/sdk'], '^1.32.2');
  assert.equal(mcpPackage.dependencies.zod, '^4.6.7');
  assert.equal(mcpPackage.dependencies['cloudflare-arch-sim'], '1.0.0');

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudflare-arch-sim-workspace-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const file of ['package.json', 'package-lock.json', 'packages/mcp/package.json']) {
    const target = path.join(fixture, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  fs.cpSync(path.join(root, 'src'), path.join(fixture, 'src'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scenario.json'), path.join(fixture, 'scenario.json'));
  const entry = path.join(fixture, 'packages/mcp/mcp-server.mjs');
  fs.copyFileSync(path.join(root, 'packages/mcp/mcp-server.mjs'), entry);

  const install = run(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], fixture);
  assert.equal(install.status, 0, install.stdout + install.stderr);

  const rootTree = run(npm, ['ls', 'hono', '--workspaces=false', '--all', '--json'], fixture);
  assert.equal(rootTree.status, 1, rootTree.stdout + rootTree.stderr);
  assert.equal(JSON.parse(rootTree.stdout).dependencies, undefined);

  const mcpTree = run(npm, ['ls', 'hono', '--workspace', 'cloudflare-arch-sim-mcp', '--all', '--json'], fixture);
  assert.equal(mcpTree.status, 0, mcpTree.stdout + mcpTree.stderr);
  assert.match(JSON.stringify(JSON.parse(mcpTree.stdout)), /"hono"/);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: fixture,
    stderr: 'pipe'
  });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'cloudflare-arch-sim-boundary', version: '1.0.0' });
  await client.connect(transport);
  try {
    assert.equal((await client.listTools()).tools.length, 11);
    assert.equal((await client.listResources()).resources.length, 3);
    assert.deepEqual((await client.listPrompts()).prompts.map(prompt => prompt.name), ['assess_architecture']);
    assert.equal(stderr, '');
  } finally {
    await client.close();
    transport.stderr.destroy();
  }
});
