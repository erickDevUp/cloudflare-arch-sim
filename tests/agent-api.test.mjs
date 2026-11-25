import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import API from '../src/agent-api.js';
import SCENARIO from '../src/scenario.js';
import PRICING from '../src/pricing.js';

const catalog = new Function('window',
  fs.readFileSync(new URL('../src/catalog.js', import.meta.url), 'utf8') + '\nreturn window.CATALOG;')({});
const clone = value => JSON.parse(JSON.stringify(value));

function candidate() {
  return {
    version: 1,
    name: 'Agent candidate',
    nodes: [
      { id: 'source', type: 'traffic', x: 20, y: 20, p: { rate: 10 } },
      { id: 'api', type: 'workers', x: 200, y: 20 },
      { id: 'queue', type: 'queues', x: 380, y: 20, p: { concurrency: 1, latency: 1000, retention: 100 } },
      { id: 'state', type: 'durable_objects', x: 560, y: 20 },
      { id: 'model', type: 'external_model', x: 200, y: 180 }
    ],
    edges: [
      { from: 'source', to: 'api' },
      { from: 'api', to: 'queue' },
      { from: 'queue', to: 'state' },
      { from: 'api', to: 'model' }
    ]
  };
}

function makeHost(input = candidate()) {
  let current = SCENARIO.validate(input, catalog).scenario;
  let loadCalls = 0;
  const simulation = {
    time: 0,
    running: false,
    speed: 60,
    spent: 0,
    rate: 0,
    pathLat: 0,
    requests: 0,
    modelSpent: 0,
    cpuRate: 0,
    baseFee: 0,
    budget: 5000,
    chaos: [],
    plan: 'paid',
    usage: { workersRequests: 1000, queueOps: 3000 },
    monthly: PRICING.monthlyCost('paid', { workersRequests: 1000, queueOps: 3000 }),
    modelSpend: { set: false, total: 0 },
    nodes: {
      queue: {
        type: 'queues', lambda: 10, util: 10, err: 0, lat: 100, cost: 0, out: 1,
        capacity: 1, backlog: 900, drops: 9, billedRequests: 0, doGbS: 0,
        objects: 0, perObjectRate: 0, objectLimit: 0, overloaded: false
      },
      state: {
        type: 'durable_objects', lambda: 1, util: 1, err: 0, lat: 30, cost: 0, out: 1,
        capacity: 0, backlog: 0, drops: 0, billedRequests: 1, doGbS: 100,
        objects: 1, perObjectRate: 1, objectLimit: 1000, overloaded: true
      }
    }
  };
  const host = {
    catalog,
    pricing: PRICING,
    scenario: SCENARIO,
    getScenario: () => clone(current),
    getSimulation: () => clone(simulation),
    getModel: () => ({ requestsPerUserPerMonth: 100, engine: {} }),
    loadScenario: scenario => {
      loadCalls++;
      current = clone(scenario);
    },
    setParams: (nodeId, patch) => {
      const node = current.nodes.find(item => item.id === nodeId);
      node.p = Object.assign({}, node.p, patch);
      return { nodeId, params: clone(node.p) };
    },
    start: speed => {
      if (speed !== undefined) simulation.speed = speed;
      simulation.running = true;
    },
    pause: () => { simulation.running = false; },
    reset: () => {
      simulation.time = 0;
      simulation.spent = 0;
      simulation.requests = 0;
      simulation.modelSpent = 0;
    },
    loadCalls: () => loadCalls
  };
  return host;
}

test('result helpers and request IDs are deterministic', () => {
  const host = makeHost();
  const sim = API.createAgentApi(host);
  assert.equal(sim.version, 1);
  assert.deepEqual(API.success('sim-v1-000001', { value: 1 }), {
    ok: true, data: { value: 1 }, requestId: 'sim-v1-000001'
  });
  assert.deepEqual(API.failure('sim-v1-000002', API.ERROR_CODES.INVALID_STATE, 'Bad state'), {
    ok: false, error: { code: 'INVALID_STATE', message: 'Bad state' }, requestId: 'sim-v1-000002'
  });
  assert.equal(sim.getState().requestId, 'sim-v1-000001');
  assert.equal(sim.exportScenario().requestId, 'sim-v1-000002');
  const missing = sim.setParams('missing', { rate: 1 });
  assert.equal(missing.requestId, 'sim-v1-000003');
  assert.equal(missing.error.code, API.ERROR_CODES.UNKNOWN_NODE);
});

test('loadScenario normalizes valid input and reports preserved-field warnings', () => {
  const host = makeHost();
  const sim = API.createAgentApi(host);
  const raw = candidate();
  raw.preview = true;
  const result = sim.loadScenario(raw);
  assert.equal(result.ok, true);
  assert.equal(result.data.scenario.name, 'Agent candidate');
  assert.equal(result.data.scenario.nodes[0].p.concurrency, 1);
  assert.equal(result.data.scenario.preview, true);
  assert.equal(result.data.warnings.length, 1);
  assert.match(result.data.warnings[0], /unknown field "preview"/);
  assert.equal(host.loadCalls(), 1);
});

test('loadScenario fails closed without partial mutation', () => {
  const host = makeHost();
  const sim = API.createAgentApi(host);
  const before = host.getScenario();
  const cases = [
    [null, API.ERROR_CODES.INVALID_SCENARIO],
    [{ version: 2, nodes: [] }, API.ERROR_CODES.INVALID_SCENARIO],
    [{ version: 1, nodes: {} }, API.ERROR_CODES.INVALID_SCENARIO],
    [{ version: 1, nodes: [{ id: '__proto__', type: 'traffic' }], edges: [] }, API.ERROR_CODES.INVALID_SCENARIO],
    [{ version: 1, nodes: [{ id: 'q', type: 'quantum_lb' }], edges: [] }, API.ERROR_CODES.UNSUPPORTED_NODE],
    [{ version: 1, nodes: [{ id: 'a', type: 'traffic', p: { replicas: 3 } }], edges: [] }, API.ERROR_CODES.INVALID_PARAMS],
    [{ version: 1, nodes: [{ id: 'a', type: 'traffic', p: { rate: 0 } }], edges: [] }, API.ERROR_CODES.INVALID_SCENARIO],
    [{ version: 1, nodes: [{ id: 'a', type: 'traffic' }, { id: 'a', type: 'workers' }], edges: [] }, API.ERROR_CODES.INVALID_SCENARIO]
  ];
  cases.forEach(([raw, code]) => {
    const result = sim.loadScenario(raw);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.deepEqual(host.getScenario(), before);
  });
  assert.equal(host.loadCalls(), 0);
});

test('a later unsupported node prevents an earlier valid node from loading', () => {
  const host = makeHost();
  const sim = API.createAgentApi(host);
  const before = host.getScenario();
  const raw = candidate();
  raw.nodes[0].p.rate = 999;
  raw.nodes.push({ id: 'future', type: 'quantum_lb' });
  const result = sim.loadScenario(raw);
  assert.equal(result.error.code, API.ERROR_CODES.UNSUPPORTED_NODE);
  assert.deepEqual(result.error.details.nodes, [{ id: 'future', type: 'quantum_lb' }]);
  assert.deepEqual(host.getScenario(), before);
  assert.equal(host.loadCalls(), 0);
});

test('legacy external Workers AI migration remains valid', () => {
  const host = makeHost({
    version: 1,
    nodes: [{ id: 'model', type: 'workers_ai', p: { inPrice: 3, outPrice: 15, inTokens: 1000, outTokens: 500 } }],
    edges: []
  });
  const result = API.createAgentApi(host).loadScenario(host.getScenario());
  assert.equal(result.ok, true);
  assert.equal(result.data.scenario.nodes[0].type, 'external_model');
});

test('setParams validates the whole patch before updating one node', () => {
  const host = makeHost();
  const sim = API.createAgentApi(host);
  const updated = sim.setParams('queue', { concurrency: 2, latency: 500 });
  assert.equal(updated.ok, true);
  assert.equal(updated.data.params.concurrency, 2);
  assert.equal(updated.data.params.latency, 500);

  const before = host.getScenario();
  const invalid = [
    ['missing', { rate: 1 }, API.ERROR_CODES.UNKNOWN_NODE],
    ['__proto__', { rate: 1 }, API.ERROR_CODES.UNKNOWN_NODE],
    ['source', {}, API.ERROR_CODES.INVALID_PARAMS],
    ['source', null, API.ERROR_CODES.INVALID_PARAMS],
    ['source', { rate: 20, unsupported: 1 }, API.ERROR_CODES.INVALID_PARAMS],
    ['source', { rate: 20, concurrency: -1 }, API.ERROR_CODES.INVALID_PARAMS],
    ['source', { rate: Number.NaN }, API.ERROR_CODES.INVALID_PARAMS],
    ['state', { transport: 'carrier-pigeon' }, API.ERROR_CODES.INVALID_PARAMS]
  ];
  invalid.forEach(([nodeId, patch, code]) => {
    const result = sim.setParams(nodeId, patch);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.deepEqual(host.getScenario(), before);
  });
});

test('start options and controls validate before mutating state', () => {
  const host = makeHost();
  const sim = API.createAgentApi(host);
  const started = sim.start({ speed: 120 });
  assert.deepEqual(started.data, { running: true, speed: 120, time: 0 });
  const before = sim.getState().data.simulation;
  [0, 7201, 1.5, { speed: 60, reset: true }, 'fast'].forEach(options => {
    const result = sim.start(options);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, API.ERROR_CODES.INVALID_PARAMS);
    assert.deepEqual(sim.getState().data.simulation, before);
  });
  assert.equal(sim.pause().data.running, false);
  assert.equal(sim.reset().data.time, 0);
});

test('getState includes simulation, billing, Queue/DO fields, assumptions, provenance, and warnings', () => {
  const host = makeHost();
  const result = API.createAgentApi(host).getState();
  assert.equal(result.ok, true);
  const state = result.data;
  assert.equal(state.version, 1);
  assert.equal(state.scenario.name, 'Agent candidate');
  assert.equal(state.simulation.speed, 60);
  assert.equal(state.plan, 'paid');
  assert.deepEqual(state.usage, { workersRequests: 1000, queueOps: 3000 });
  assert.equal(state.monthly.plan, 'paid');
  assert.deepEqual(state.modelSpend, { set: false, total: 0 });
  assert.equal(state.nodes.queue.backlog, 900);
  assert.equal(state.nodes.queue.drops, 9);
  assert.equal(state.nodes.state.billedRequests, 1);
  assert.equal(state.nodes.state.doGbS, 100);
  assert.equal(state.nodes.state.objects, 1);
  assert.equal(state.nodes.state.perObjectRate, 1);
  assert.equal(state.nodes.state.objectLimit, 1000);
  assert.equal(state.nodes.state.overloaded, true);
  assert.equal(state.assumptions.find(item => item.id === 'requestsPerUserPerMonth').classification,
    'editable_model_assumption');
  assert.equal(state.provenance.pricing.asOf, PRICING.asOf);
  assert.equal(state.provenance.pricing.dimensions.every(item => item.verified), true);
  assert.ok(state.provenance.nodes.api.verified);
  assert.equal(state.provenance.nodes.api.source, catalog.types.workers.doc);
  assert.equal(state.provenance.nodes.api.params.latency.classification, 'editable_model_assumption');
  const codes = state.warnings.map(item => item.code);
  ['QUEUE_BACKLOG', 'QUEUE_EXPIRY', 'DURABLE_OBJECT_OVERLOAD', 'MODEL_SPEND_UNSET'].forEach(code => {
    assert.ok(codes.includes(code), code);
  });
});

test('getState warns about cycles and unsupported boot data', () => {
  const host = makeHost({
    version: 1,
    nodes: [
      { id: 'a', type: 'workers' },
      { id: 'b', type: 'workers' },
      { id: 'q', type: 'quantum_lb' }
    ],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]
  });
  const state = API.createAgentApi(host).getState().data;
  const codes = state.warnings.map(item => item.code);
  assert.ok(codes.includes('CYCLE_DETECTED'));
  assert.ok(codes.includes('UNSUPPORTED_NODE'));
});

test('exportScenario is canonical and returns an isolated copy', () => {
  const host = makeHost();
  const sim = API.createAgentApi(host);
  const first = sim.exportScenario();
  assert.equal(first.ok, true);
  const canonical = JSON.stringify(first.data);
  first.data.nodes[0].p.rate = 999;
  assert.equal(JSON.stringify(sim.exportScenario().data), canonical);
  const loaded = sim.loadScenario(sim.exportScenario().data);
  assert.equal(JSON.stringify(loaded.data.scenario), canonical);
});

test('invalid host state and unexpected failures use structured errors', () => {
  const host = makeHost();
  host.getScenario = () => null;
  const invalid = API.createAgentApi(host).getState();
  assert.equal(invalid.error.code, API.ERROR_CODES.INVALID_STATE);

  const broken = makeHost();
  broken.getScenario = () => { throw new Error('host exploded'); };
  const internal = API.createAgentApi(broken).getState();
  assert.equal(internal.ok, false);
  assert.equal(internal.error.code, API.ERROR_CODES.INTERNAL_ERROR);
  assert.equal(internal.error.details.message, 'host exploded');
});
