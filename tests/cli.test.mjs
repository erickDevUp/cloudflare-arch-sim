import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'cli.mjs');
const html = path.join(root, 'dist', 'cloudflare-arch-sim.html');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
  cwd: root,
  encoding: 'utf8',
  timeout: 5000
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('help describes valid agent-facing flags', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /--port <port>\s+Listen on 1-65535/);
  assert.match(result.stdout, /--scenario <file>/);
});

test('path prints the bundled HTML without starting a server', () => {
  const result = run('--path');
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, html + '\n');
});

test('missing flag values fail with concise stderr', () => {
  for (const flag of ['--port', '--scenario']) {
    const result = run(flag);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `Missing value for ${flag}.\n`);
  }
});

test('invalid ports fail before starting a server', () => {
  for (const port of ['abc', '0', '65536', '1.5', '-1']) {
    const result = run('--port', port);
    assert.equal(result.status, 1, port);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Invalid --port: .*expected an integer from 1 to 65535\.\n$/);
  }
});

test('missing and unreadable scenario files fail before starting a server', () => {
  const missing = run('--scenario', path.join(root, 'does-not-exist.json'));
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /^Invalid --scenario: .*file does not exist.*\n$/);
});

test('malformed scenario JSON and invalid roots fail before starting a server', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudflare-arch-sim-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, content, problem] of [
    ['broken.json', '{broken', 'invalid JSON'],
    ['array.json', '[]', 'expected an object with a "nodes" array'],
    ['missing-nodes.json', '{}', 'expected an object with a "nodes" array']
  ]) {
    const file = path.join(directory, name);
    fs.writeFileSync(file, content);
    const result = run('--scenario', file);
    assert.equal(result.status, 1, name);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp('^Invalid --scenario: .*' + problem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*\\n$'));
  }
});

test('valid port and scenario values preserve the server behavior', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [
    cli,
    '--port', String(port),
    '--scenario', path.join(root, 'scenario.json')
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });

  try {
    let response;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (child.exitCode !== null) break;
      try {
        response = await fetch(`http://127.0.0.1:${port}/scenario`);
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    assert.ok(response, stderr || 'server did not start');
    assert.equal(response.status, 200);
    const scenario = await response.json();
    assert.equal(scenario.name, 'Beauty store on Cloudflare');
    assert.ok(Array.isArray(scenario.nodes));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
});
