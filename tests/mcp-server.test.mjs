import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOL_NAMES, TOOL_SCHEMAS } from '../mcp-server.mjs';

const entry = fileURLToPath(new URL('../mcp-server.mjs', import.meta.url));

function scenario() {
  return {
    version: 1,
    name: 'MCP candidate',
    nodes: [
      { id: 'source', type: 'traffic', p: { rate: 10 } },
      { id: 'api', type: 'workers', p: { latency: 20, cpuMs: 5 } },
      { id: 'queue', type: 'queues', p: { concurrency: 1, latency: 1000, retention: 100 } }
    ],
    edges: [{ from: 'source', to: 'api' }, { from: 'api', to: 'queue' }]
  };
}

function envelope(result, ok = true) {
  assert.equal(result.isError, !ok);
  assert.equal(result.content[0].type, 'text');
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(result.structuredContent, parsed);
  assert.equal(parsed.ok, ok);
  return parsed;
}

async function connectClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stderr: 'pipe'
  });
  const stderr = transport.stderr;
  assert.ok(stderr);
  let stderrText = '';
  stderr.on('data', chunk => { stderrText += chunk.toString(); });
  const client = new Client({ name: 'cloudflare-arch-sim-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport, stderr, stderrText: () => stderrText };
}

test('MCP tool schemas are explicit, strict, and bounded', () => {
  assert.deepEqual(TOOL_NAMES, [
    'sim_capabilities',
    'sim_validate_scenario',
    'sim_load_scenario',
    'sim_set_node_params',
    'sim_set_plan',
    'sim_set_billing_inputs',
    'sim_advance',
    'sim_pause',
    'sim_reset',
    'sim_get_state',
    'sim_export_scenario'
  ]);
  assert.equal(TOOL_SCHEMAS.sim_capabilities.safeParse({}).success, true);
  assert.equal(TOOL_SCHEMAS.sim_capabilities.safeParse({ extra: true }).success, false);
  assert.equal(TOOL_SCHEMAS.sim_validate_scenario.safeParse({ scenario: scenario() }).success, true);
  assert.equal(TOOL_SCHEMAS.sim_validate_scenario.safeParse({ scenario: null }).success, false);
  assert.equal(TOOL_SCHEMAS.sim_validate_scenario.safeParse({}).success, false);
  assert.equal(TOOL_SCHEMAS.sim_load_scenario.safeParse({ scenario: scenario(), options: { resetRuntime: false } }).success, true);
  assert.equal(TOOL_SCHEMAS.sim_load_scenario.safeParse({ scenario: scenario(), options: { persist: true } }).success, false);
  assert.equal(TOOL_SCHEMAS.sim_load_scenario.safeParse({ scenario: scenario(), options: { strict: false } }).success, false);
  assert.equal(TOOL_SCHEMAS.sim_set_node_params.safeParse({ nodeId: 'source', params: { rate: 20 } }).success, true);
  assert.equal(TOOL_SCHEMAS.sim_set_node_params.safeParse({ nodeId: '', params: { rate: 20 } }).success, false);
  assert.equal(TOOL_SCHEMAS.sim_set_node_params.safeParse({ nodeId: 'source', params: [] }).success, false);
  assert.equal(TOOL_SCHEMAS.sim_set_plan.safeParse({ plan: 'free' }).success, true);
  assert.equal(TOOL_SCHEMAS.sim_set_plan.safeParse({ plan: 'enterprise' }).success, false);
  assert.equal(TOOL_SCHEMAS.sim_set_billing_inputs.safeParse({ inputs: { baseFee: 0, budget: 1 } }).success, true);
  assert.equal(TOOL_SCHEMAS.sim_set_billing_inputs.safeParse({ inputs: { budget: 0 } }).success, false);
  assert.equal(TOOL_SCHEMAS.sim_set_billing_inputs.safeParse({ inputs: { rateMonthly: 1 } }).success, false);
  assert.equal(TOOL_SCHEMAS.sim_advance.safeParse({ seconds: 1 }).success, true);
  assert.equal(TOOL_SCHEMAS.sim_advance.safeParse({ seconds: 0 }).success, false);
  assert.equal(TOOL_SCHEMAS.sim_advance.safeParse({ seconds: 31536001 }).success, false);
  assert.equal(TOOL_SCHEMAS.sim_advance.safeParse({ seconds: Number.POSITIVE_INFINITY }).success, false);
  assert.equal(TOOL_SCHEMAS.sim_export_scenario.safeParse({ options: { assessment: true, provenance: true } }).success, true);
  assert.equal(TOOL_SCHEMAS.sim_export_scenario.safeParse({ options: { save: true } }).success, false);
});

test('SDK stdio client lists and exercises tools, resources, prompt, errors, and atomic state', async () => {
  const { client, stderr, stderrText } = await connectClient();
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name), TOOL_NAMES);
    listed.tools.forEach(tool => {
      assert.ok(tool.description.length > 20);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false);
    });
    assert.deepEqual(listed.tools.find(tool => tool.name === 'sim_set_plan').inputSchema.properties.plan.enum, ['free', 'paid', 'custom']);
    assert.equal(listed.tools.find(tool => tool.name === 'sim_advance').inputSchema.properties.seconds.exclusiveMinimum, 0);

    const resources = await client.listResources();
    assert.deepEqual(resources.resources.map(resource => resource.uri).sort(), [
      'catalog://nodes',
      'pricing://provenance',
      'scenario://default'
    ]);
    const defaultResource = await client.readResource({ uri: 'scenario://default' });
    const defaultPayload = JSON.parse(defaultResource.contents[0].text);
    assert.equal(defaultPayload.version, 1);
    assert.ok(defaultPayload.nodes.length > 0);
    const catalogResource = await client.readResource({ uri: 'catalog://nodes' });
    const catalogPayload = JSON.parse(catalogResource.contents[0].text);
    assert.equal(catalogPayload.types.workers.name, 'Workers');
    assert.ok(Array.isArray(catalogPayload.ranges.rate));
    const pricingResource = await client.readResource({ uri: 'pricing://provenance' });
    const pricingPayload = JSON.parse(pricingResource.contents[0].text);
    assert.equal(pricingPayload.dimensions.length, 19);
    assert.ok(pricingPayload.sources.workers);

    const prompts = await client.listPrompts();
    assert.deepEqual(prompts.prompts.map(prompt => prompt.name), ['assess_architecture']);
    const prompt = await client.getPrompt({ name: 'assess_architecture', arguments: { goal: 'Static site with Queue backpressure' } });
    assert.equal(prompt.messages[0].role, 'user');
    const promptText = prompt.messages[0].content.text;
    TOOL_NAMES.forEach(name => assert.ok(promptText.includes(name), name));
    assert.match(promptText, /exact simulated seconds/);
    assert.match(promptText, /local stdio only/);

    const requestIds = [];
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      const parsed = envelope(result, result.isError !== true);
      if (parsed.requestId) requestIds.push(Number(parsed.requestId.slice(-6)));
      return parsed;
    };
    const capabilities = await call('sim_capabilities', {});
    assert.equal(capabilities.data.transport, 'stdio');
    assert.equal(capabilities.data.persistence.available, false);
    assert.equal(capabilities.data.methods.includes('save'), false);
    assert.equal(capabilities.data.methods.includes('run'), true);

    const initial = await call('sim_get_state', {});
    assert.equal(initial.data.time, 0);
    const validated = await call('sim_validate_scenario', { scenario: scenario() });
    assert.equal(validated.data.valid, true);
    assert.deepEqual(initial.data, (await call('sim_get_state', {})).data);

    const invalidSchema = await call('sim_validate_scenario', { scenario: { version: 2, nodes: [] } });
    assert.equal(invalidSchema.error.code, 'UNSUPPORTED_SCHEMA_VERSION');
    assert.equal(invalidSchema.error.path, '/scenario');
    const missingScenario = await call('sim_validate_scenario', {});
    assert.equal(missingScenario.error.code, 'INVALID_SCENARIO');
    assert.equal(missingScenario.error.path, '/scenario');
    assert.ok(Array.isArray(missingScenario.error.details.issues));
    assert.deepEqual(initial.data, (await call('sim_get_state', {})).data);

    const loaded = await call('sim_load_scenario', { scenario: scenario(), options: { resetRuntime: true } });
    assert.equal(loaded.data.scenario.name, 'MCP candidate');
    assert.equal(loaded.data.dirty, true);
    const loadedState = await call('sim_get_state', {});
    const invalidLoad = await call('sim_load_scenario', {
      scenario: { version: 1, nodes: [{ id: 'future', type: 'quantum_lb' }], edges: [] }
    });
    assert.equal(invalidLoad.error.code, 'UNSUPPORTED_NODE_TYPE');
    assert.deepEqual(loadedState.data, (await call('sim_get_state', {})).data);

    const patched = await call('sim_set_node_params', { nodeId: 'queue', params: { concurrency: 2, latency: 500 } });
    assert.equal(patched.data.params.concurrency, 2);
    const patchedState = await call('sim_get_state', {});
    const invalidPatch = await call('sim_set_node_params', { nodeId: 'queue', params: { concurrency: 3, unsupported: 1 } });
    assert.equal(invalidPatch.error.code, 'UNSUPPORTED_PARAMETER');
    assert.equal(invalidPatch.error.path, '/params');
    assert.deepEqual(patchedState.data, (await call('sim_get_state', {})).data);

    const free = await call('sim_set_plan', { plan: 'free' });
    assert.equal(free.data.monthly.total, 0);
    const paid = await call('sim_set_plan', { plan: 'paid' });
    assert.equal(paid.data.monthly.base, 5);
    await call('sim_set_plan', { plan: 'custom' });
    const billed = await call('sim_set_billing_inputs', { inputs: { baseFee: 25, budget: 1000 } });
    assert.equal(billed.data.baseFee, 25);
    assert.equal(billed.data.monthly.base, 25);
    const billedState = await call('sim_get_state', {});
    const invalidBilling = await call('sim_set_billing_inputs', { inputs: { budget: 0 } });
    assert.equal(invalidBilling.error.code, 'PARAMETER_OUT_OF_RANGE');
    assert.equal(invalidBilling.error.path, '/inputs/budget');
    assert.deepEqual(billedState.data, (await call('sim_get_state', {})).data);

    const advanced = await call('sim_advance', { seconds: 10 });
    assert.equal(advanced.data.time, 10);
    const advancedState = await call('sim_get_state', {});
    assert.equal(advancedState.data.requestCount, 100);
    const invalidAdvance = await call('sim_advance', { seconds: 0 });
    assert.equal(invalidAdvance.error.code, 'INVALID_OPTIONS');
    assert.equal(invalidAdvance.error.path, '/seconds');
    assert.deepEqual(advancedState.data, (await call('sim_get_state', {})).data);
    const missingAdvance = await call('sim_advance', {});
    assert.equal(missingAdvance.error.code, 'INVALID_OPTIONS');
    assert.equal(missingAdvance.error.path, '/seconds');

    assert.equal((await call('sim_pause', {})).data.running, false);
    const exported = await call('sim_export_scenario', { options: { assessment: true, provenance: true } });
    assert.equal(exported.data.scenario.name, 'MCP candidate');
    assert.ok(exported.data.assessment.cloudflare.allowances.length > 0);
    assert.equal(exported.data.provenance.asOf, '2026-11-24');
    const reset = await call('sim_reset', {});
    assert.equal(reset.data.time, 0);
    assert.notEqual(reset.data.runId, advanced.data.runId);
    const resetState = await call('sim_get_state', {});
    assert.equal(resetState.data.requestCount, 0);
    assert.equal(resetState.data.baseFee, 25);
    assert.deepEqual(resetState.data.scenario, exported.data.scenario);

    const unknown = await call('sim_save', {});
    assert.equal(unknown.error.code, 'UNKNOWN_TOOL');
    assert.equal(unknown.error.path, '/name');
    const extraArgs = await call('sim_capabilities', { save: true });
    assert.equal(extraArgs.error.code, 'INVALID_ARGUMENTS');
    assert.equal(extraArgs.error.path, '/');
    const beforeUnknown = await call('sim_get_state', {});
    assert.deepEqual(beforeUnknown.data, resetState.data);

    requestIds.forEach((id, index) => {
      if (index > 0) assert.equal(id, requestIds[index - 1] + 1);
    });
    assert.equal(stderrText(), '');
  } finally {
    await client.close();
    stderr.destroy();
  }
});

test('direct stdio entry exits cleanly with empty stdout and stderr when stdin closes', async () => {
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdin.end();
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});
