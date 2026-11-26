import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

test('MCP stdio preserves the exact 11-tool, 3-resource, and prompt discovery surface', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'packages/mcp/mcp-server.mjs')],
    cwd: root,
    stderr: 'pipe'
  });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'cloudflare-arch-sim-characterization', version: '1.0.0' });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const resources = await client.listResources();
    const contents = [];
    for (const resource of resources.resources) contents.push(await client.readResource({ uri: resource.uri }));
    const prompts = await client.listPrompts();
    const prompt = await client.getPrompt({
      name: 'assess_architecture', arguments: { goal: 'Static site with Queue backpressure' }
    });
    assert.deepEqual(tools.tools.map(tool => tool.name), [
      'sim_capabilities', 'sim_validate_scenario', 'sim_load_scenario', 'sim_set_node_params',
      'sim_set_plan', 'sim_set_billing_inputs', 'sim_advance', 'sim_pause', 'sim_reset',
      'sim_get_state', 'sim_export_scenario'
    ]);
    assert.deepEqual(resources.resources.map(resource => resource.uri), [
      'scenario://default', 'catalog://nodes', 'pricing://provenance'
    ]);
    assert.deepEqual(prompts.prompts.map(item => item.name), ['assess_architecture']);
    const surface = canonical({ tools: tools.tools, resources: resources.resources, contents, prompts: prompts.prompts, prompt });
    const digest = createHash('sha256').update(JSON.stringify(surface)).digest('hex');
    assert.equal(digest, '683d51f619ab6923cc979a9e490853f2cf6cb5da853d277be6061ad502108824');
    assert.equal(stderr, '');
  } finally {
    await client.close();
    transport.stderr.destroy();
  }
});
