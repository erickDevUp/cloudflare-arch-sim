import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../src/state-core.mjs';
import API from '../src/agent-api.js';
import CATALOG from '../src/catalog.js';
import ENGINE from '../src/engine.js';
import PRICING from '../src/pricing.js';
import SCENARIO from '../src/scenario.js';
import HEADLESS from '../src/headless-service.js';

const defaultScenario = JSON.parse(fs.readFileSync(new URL('../scenario.json', import.meta.url), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));

function candidate() {
  return {
    version: 1,
    name: 'Headless candidate',
    nodes: [
      { id: 'source', type: 'traffic', p: { rate: 10 } },
      { id: 'api', type: 'workers', p: { latency: 20, cpuMs: 5 } },
      { id: 'queue', type: 'queues', p: { concurrency: 1, latency: 1000, retention: 100 } },
      { id: 'state', type: 'durable_objects' },
      { id: 'model', type: 'external_model' }
    ],
    edges: [
      { from: 'source', to: 'api' },
      { from: 'api', to: 'queue' },
      { from: 'queue', to: 'state' },
      { from: 'api', to: 'model' }
    ]
  };
}

function makeService(input = candidate()) {
  return HEADLESS.createHeadlessSimulator({
    scenario: SCENARIO,
    catalog: CATALOG,
    pricing: PRICING,
    engine: ENGINE,
    agentApi: API,
    defaultScenario: input
  });
}

test('headless service boots the canonical default with deterministic identity and no persistence', () => {
  const service = makeService(defaultScenario);
  const capabilities = service.capabilities();
  assert.equal(capabilities.ok, true);
  assert.equal(capabilities.data.apiVersion, 1);
  assert.equal(capabilities.data.deterministicClock, true);
  assert.equal(capabilities.data.persistence.available, false);
  assert.equal(capabilities.data.persistence.transport, 'stdio');
  const state = service.getState().data;
  assert.equal(state.runId, 'run-000001');
  assert.equal(state.time, 0);
  assert.equal(state.running, false);
  assert.equal(state.plan, 'paid');
  assert.equal(state.dirty, true);
  assert.equal(state.scenarioRevision, null);
  assert.equal(state.scenarioHash, null);
  assert.equal(state.scenario.nodes.length, defaultScenario.nodes.length);
  assert.equal(state.scenario.nodes.find(node => node.id === 'n5').p.objects, 1);
  assert.equal(state.scenario.nodes.find(node => node.id === 'n10').p.retention, ENGINE.DEFAULT_RETENTION);
});

test('strict validation is non-mutating and every failure consumes a request id', () => {
  const service = makeService();
  const before = service.getState().data;
  const raw = candidate();
  raw.preview = { enabled: true };
  const original = clone(raw);
  const valid = service.validate(raw);
  assert.equal(valid.ok, true);
  assert.equal(valid.data.valid, true);
  assert.deepEqual(valid.data.scenario.preview, { enabled: true });
  assert.equal(valid.data.warnings.length, 1);
  assert.deepEqual(raw, original);
  assert.deepEqual(service.getState().data, before);

  const cases = [
    [null, API.ERROR_CODES.INVALID_SCENARIO],
    [{ version: 2, nodes: [] }, API.ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION],
    [{ version: 1, nodes: {} }, API.ERROR_CODES.INVALID_SCENARIO],
    [{ version: 1, nodes: [{ id: 'q', type: 'quantum_lb' }] }, API.ERROR_CODES.UNSUPPORTED_NODE_TYPE],
    [{ version: 1, nodes: [{ id: 'a', type: 'traffic', p: { replicas: 3 } }] }, API.ERROR_CODES.UNSUPPORTED_PARAMETER],
    [{ version: 1, nodes: [{ id: 'a', type: 'traffic', p: { rate: 0 } }] }, API.ERROR_CODES.PARAMETER_OUT_OF_RANGE],
    [{ version: 1, nodes: [{ id: '__proto__', type: 'traffic' }] }, API.ERROR_CODES.INVALID_SCENARIO],
    [{ version: 1, nodes: [{ id: 'a', type: 'traffic' }, { id: 'a', type: 'workers' }] }, API.ERROR_CODES.INVALID_SCENARIO]
  ];
  cases.forEach(([value, code], index) => {
    const result = service.validate(value);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(result.requestId, 'sim-v1-' + String(4 + index * 2).padStart(6, '0'));
    assert.deepEqual(service.getState().data, before);
  });
});

test('loadScenario installs atomically, preserves unknown fields, and supports runtime reset control', () => {
  const service = makeService();
  service.run({ seconds: 10 });
  const before = service.getState().data;
  const invalid = candidate();
  invalid.nodes[0].p.rate = 20;
  invalid.nodes.push({ id: 'future', type: 'quantum_lb' });
  const rejected = service.loadScenario(invalid);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, API.ERROR_CODES.UNSUPPORTED_NODE_TYPE);
  assert.deepEqual(service.getState().data, before);

  const raw = candidate();
  raw.name = 'Runtime preserved';
  raw.preview = true;
  const loaded = service.loadScenario(raw, { resetRuntime: false });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.data.scenario.preview, true);
  assert.notEqual(loaded.data.runId, before.runId);
  const preserved = service.getState().data;
  assert.equal(preserved.time, 10);
  assert.equal(preserved.requestCount, 100);
  assert.equal(preserved.nodes.queue.backlog, before.nodes.queue.backlog);

  const reset = service.loadScenario(candidate());
  assert.equal(reset.ok, true);
  const state = service.getState().data;
  assert.equal(state.time, 0);
  assert.equal(state.requestCount, 0);
  assert.equal(state.nodes.queue.backlog, 0);
  assert.equal(state.running, false);
});

test('setParams validates the whole patch before recomputing metrics', () => {
  const service = makeService();
  const updated = service.setParams('source', { rate: 20 });
  assert.equal(updated.ok, true);
  assert.equal(updated.data.params.rate, 20);
  assert.equal(service.getState().data.nodes.api.lambda, 20);

  const before = service.getState().data;
  const invalid = [
    ['missing', { rate: 1 }, API.ERROR_CODES.UNKNOWN_NODE],
    ['__proto__', { rate: 1 }, API.ERROR_CODES.UNKNOWN_NODE],
    ['source', {}, API.ERROR_CODES.INVALID_PARAMS],
    ['source', { rate: 30, unsupported: 1 }, API.ERROR_CODES.UNSUPPORTED_PARAMETER],
    ['source', { rate: 30, concurrency: -1 }, API.ERROR_CODES.PARAMETER_OUT_OF_RANGE],
    ['source', { rate: Number.NaN }, API.ERROR_CODES.INVALID_PARAMS],
    ['state', { transport: 'carrier-pigeon' }, API.ERROR_CODES.INVALID_PARAMS]
  ];
  invalid.forEach(([nodeId, patch, code]) => {
    const result = service.setParams(nodeId, patch);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.deepEqual(service.getState().data, before);
  });
});

test('exact advancement integrates Queue backlog and retention deterministically', () => {
  const first = makeService();
  const second = makeService();
  assert.deepEqual(first.getState().data, second.getState().data);
  assert.equal(first.run({ seconds: 10 }).data.time, 10);
  assert.equal(second.run({ seconds: 10 }).data.time, 10);
  assert.deepEqual(first.getState().data, second.getState().data);
  const tenSeconds = ENGINE.step(0, 10, 1, 10, 100);
  assert.equal(first.getState().data.nodes.queue.backlog, tenSeconds.backlog);
  assert.equal(first.getState().data.nodes.queue.drops, tenSeconds.drops);
  assert.equal(first.getState().data.requestCount, 100);

  first.run({ seconds: 20 });
  const state = first.getState().data;
  const thirtySeconds = ENGINE.step(tenSeconds.backlog, 10, 1, 20, 100);
  assert.equal(state.time, 30);
  assert.equal(state.requestCount, 300);
  assert.equal(state.nodes.queue.backlog, thirtySeconds.backlog);
  assert.equal(state.nodes.queue.drops, thirtySeconds.drops);
  assert.equal(state.running, false);

  const before = clone(state);
  [{}, { seconds: 0 }, { seconds: -1 }, { seconds: Infinity }, { seconds: API.LIMITS.maxRunSeconds + 1 }, { seconds: 1, extra: true }]
    .forEach(options => {
      const result = first.run(options);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, API.ERROR_CODES.INVALID_OPTIONS);
      assert.deepEqual(first.getState().data, before);
    });
});

test('plan and billing changes recompute allowances without resetting runtime', () => {
  const service = makeService();
  service.run({ seconds: 60 });
  const before = service.getState().data;
  const free = service.setPlan('free');
  assert.equal(free.ok, true);
  assert.equal(free.data.time, before.time);
  assert.equal(free.data.monthly.total, 0);
  assert.ok(free.data.cloudflare.allowances.every(item => item.cost === 0));

  const paid = service.setPlan('paid');
  assert.equal(paid.ok, true);
  assert.equal(paid.data.monthly.base, PRICING.plans.paid.base);
  assert.equal(paid.data.cloudflare.allowances.find(item => item.id === 'workersRequests').period, 'per month');

  service.setPlan('custom');
  const billed = service.setBillingInputs({ baseFee: 25, budget: 1000 });
  assert.equal(billed.ok, true);
  assert.equal(billed.data.baseFee, 25);
  assert.equal(billed.data.budget, 1000);
  assert.equal(billed.data.monthly.base, 25);
  assert.equal(billed.data.monthly.total, 25 + PRICING.monthlyUsage(billed.data.cloudflare.rate));
  assert.ok(billed.data.cloudflare.allowances.every(item => item.billable === null && item.cost === null));

  const stable = service.getState().data;
  assert.equal(service.setPlan('enterprise').error.code, API.ERROR_CODES.INVALID_PARAMS);
  assert.equal(service.setBillingInputs({ baseFee: -1 }).error.code, API.ERROR_CODES.PARAMETER_OUT_OF_RANGE);
  assert.equal(service.setBillingInputs({ budget: 0 }).error.code, API.ERROR_CODES.PARAMETER_OUT_OF_RANGE);
  assert.equal(service.setBillingInputs({ baseFee: 10, extra: true }).error.code, API.ERROR_CODES.UNSUPPORTED_PARAMETER);
  assert.deepEqual(service.getState().data, stable);
});

test('external model spend stays separate from Cloudflare spend and accumulates exactly', () => {
  const raw = {
    version: 1,
    nodes: [
      { id: 'source', type: 'traffic', p: { rate: 20 } },
      {
        id: 'model',
        type: 'external_model',
        p: { inPrice: 3, outPrice: 15, inTokens: 1000, outTokens: 500 }
      }
    ],
    edges: [{ from: 'source', to: 'model' }]
  };
  const service = makeService(raw);
  service.run({ seconds: 60 });
  const state = service.getState().data;
  assert.equal(state.model.set, true);
  assert.ok(state.model.monthly > 0);
  assert.equal(state.cloudflare.monthly.total, PRICING.plans.paid.base);
  assert.equal(state.cloudflare.rate, 0);
  assert.equal(state.model.accumulated, state.model.monthly / (3600 * PRICING.hoursPerMonth) * 60);
  assert.equal(state.model.perRequest, state.model.accumulated / state.requestCount);
});

test('state and provenance expose model identity, assumptions, diagnostics, and pricing sources', () => {
  const service = makeService();
  const state = service.getState().data;
  assert.equal(state.apiVersion, 1);
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.modelVersion, 'rate-v1');
  assert.equal(state.units.time, 'simulated seconds');
  assert.equal(state.provenance.asOf, PRICING.asOf);
  assert.deepEqual(state.provenance.sources, PRICING.sources);
  assert.equal(state.provenance.nodes.api.verified, true);
  assert.equal(state.provenance.nodes.api.source, CATALOG.types.workers.doc);
  assert.equal(state.provenance.nodes.api.params.latency.classification, 'editable_model_assumption');
  assert.ok(state.assumptions.some(item => item.id === 'requestsPerUserPerMonth'));
  assert.ok(state.warnings.some(item => item.code === 'MODEL_SPEND_UNSET'));
  assert.ok(state.limitations.every(item => !item.includes('MCP')));
});

test('reset clears runtime only and preserves architecture, billing, speed, and dirty state', () => {
  const service = makeService();
  service.setSpeed(180);
  service.setPlan('custom');
  service.setBillingInputs({ baseFee: 25, budget: 100 });
  service.setParams('source', { rate: 20 });
  service.start();
  service.run({ seconds: 5 });
  const before = service.getState().data;
  const scenario = service.exportScenario().data;
  const reset = service.reset();
  assert.equal(reset.ok, true);
  assert.notEqual(reset.data.runId, before.runId);
  assert.equal(reset.data.running, false);
  assert.equal(reset.data.time, 0);
  assert.equal(reset.data.speed, 180);
  const state = service.getState().data;
  assert.equal(state.requestCount, 0);
  assert.equal(state.nodes.queue.backlog, 0);
  assert.equal(state.nodes.queue.drops, 0);
  assert.equal(state.plan, 'custom');
  assert.equal(state.baseFee, 25);
  assert.equal(state.budget, 100);
  assert.equal(state.dirty, true);
  assert.deepEqual(service.exportScenario().data, scenario);
  assert.equal(service.pause().data.running, false);
});

test('export is canonical, isolated, and includes optional assessment and provenance', () => {
  const service = makeService();
  service.run({ seconds: 10 });
  const first = service.exportScenario();
  const canonical = JSON.stringify(first.data);
  first.data.nodes[0].p.rate = 999;
  assert.equal(JSON.stringify(service.exportScenario().data), canonical);
  const loaded = service.loadScenario(service.exportScenario().data);
  assert.equal(JSON.stringify(loaded.data.scenario), canonical);
  const assessment = service.exportScenario({ assessment: true, provenance: true });
  assert.equal(assessment.ok, true);
  assert.equal(assessment.data.assessment.cloudflare.allowances.length, PRICING.dims.length);
  assert.equal(assessment.data.assessment.model.priceInputs.length, 1);
  assert.equal(assessment.data.provenance.asOf, PRICING.asOf);
});

test('headless persistence fails closed without changing state', async () => {
  const service = makeService();
  const before = service.getState().data;
  const result = await service.save();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, API.ERROR_CODES.CHANNEL_UNAVAILABLE);
  assert.deepEqual(service.getState().data, before);
});
