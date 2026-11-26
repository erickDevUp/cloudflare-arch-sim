import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import API from '../src/agent-api.js';
import SCENARIO from '../src/scenario.js';
import ENGINE from '../src/engine.js';
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
  let saveCalls = 0;
  let storedRevision = 7;
  let storedHash = 'sha256-initial';
  let runSeq = 0;
  const nextRunId = () => 'run-' + String(++runSeq).padStart(6, '0');
  const identity = {
    scenarioRevision: 7,
    scenarioHash: 'sha256-initial',
    runId: nextRunId(),
    dirty: false,
    saving: false,
    saveError: null
  };
  const simulation = {
    time: 0,
    running: false,
    speed: 60,
    spent: 0,
    rate: 0,
    pathLat: 0,
    requests: 0,
    requestCount: 0,
    modelSpent: 0,
    cpuRate: 0,
    baseFee: 0,
    budget: 5000,
    chaos: {},
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
  const refreshBilling = () => {
    simulation.monthly = PRICING.monthlyCost(simulation.plan, Object.assign({}, simulation.usage, {
      baseFee: simulation.baseFee,
      rateMonthly: PRICING.monthlyUsage(simulation.rate)
    }));
  };
  const resetRuntime = () => {
    Object.assign(simulation, {
      time: 0, running: false, spent: 0, requests: 0, requestCount: 0,
      modelSpent: 0, chaos: {}
    });
    simulation.nodes.queue.backlog = 0;
    simulation.nodes.queue.drops = 0;
  };
  const host = {
    catalog,
    pricing: PRICING,
    scenario: SCENARIO,
    runtime: simulation,
    getScenario: () => clone(current),
    getSimulation: () => clone(simulation),
    getIdentity: () => clone(identity),
    getModel: () => ({ requestsPerUserPerMonth: 100, engine: Object.assign({}, ENGINE.MODEL) }),
    loadScenario: (scenario, options) => {
      loadCalls++;
      current = clone(scenario);
      identity.runId = nextRunId();
      if (!options || options.resetRuntime !== false) resetRuntime();
      identity.scenarioRevision = options && options.persisted ? storedRevision : null;
      identity.scenarioHash = options && options.persisted ? storedHash : null;
      identity.dirty = !(options && options.persisted);
      identity.saveError = null;
    },
    setParams: (nodeId, patch) => {
      const node = current.nodes.find(item => item.id === nodeId);
      node.p = Object.assign({}, node.p, patch);
      identity.dirty = true;
      identity.scenarioRevision = null;
      identity.scenarioHash = null;
      identity.saveError = null;
      return { nodeId, params: clone(node.p) };
    },
    setPlan: plan => {
      simulation.plan = plan;
      refreshBilling();
    },
    setBillingInputs: patch => {
      Object.assign(simulation, patch);
      refreshBilling();
    },
    start: speed => {
      if (speed !== undefined) simulation.speed = speed;
      simulation.running = true;
    },
    pause: () => { simulation.running = false; },
    reset: () => {
      simulation.running = false;
      resetRuntime();
      identity.runId = nextRunId();
    },
    run: seconds => {
      simulation.running = false;
      ENGINE.advanceClock(simulation, seconds, dt => {
        const queue = simulation.nodes.queue;
        const next = ENGINE.step(queue.backlog, 10, 1, dt, 100);
        queue.backlog = next.backlog;
        queue.drops = next.drops;
        return { rate: simulation.rate, requests: 10, modelRate: 0 };
      });
      simulation.requestCount = simulation.requests;
    },
    setSpeed: speed => { simulation.speed = speed; },
    saveScenario: async scenario => {
      saveCalls++;
      storedRevision++;
      storedHash = 'sha256-' + saveCalls;
      if (JSON.stringify(current) === JSON.stringify(scenario)) {
        identity.scenarioRevision = storedRevision;
        identity.scenarioHash = storedHash;
        identity.dirty = false;
        identity.saveError = null;
      }
      return { data: { revision: storedRevision, hash: storedHash, scenario: clone(scenario) } };
    },
    getChannelStatus: () => ({ available: true, saving: identity.saving, revision: identity.scenarioRevision, hash: identity.scenarioHash }),
    failSave: error => {
      identity.dirty = true;
      identity.saveError = error;
      return { error };
    },
    loadCalls: () => loadCalls,
    saveCalls: () => saveCalls
  };
  return host;
}

test('result helpers and request IDs are deterministic', () => {
  const host = makeHost();
  const sim = API.createAgentApi(host);
  assert.equal(sim.version, 1);
  assert.equal(sim.apiVersion, 1);
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

test('capabilities advertise versions, node types, limits, and deterministic clock', () => {
  const host = makeHost();
  const result = API.createAgentApi(host).capabilities();
  assert.equal(result.ok, true);
  assert.equal(result.data.apiVersion, 1);
  assert.equal(result.data.schemaVersion, 1);
  assert.equal(result.data.modelVersion, 'rate-v1');
  assert.equal(result.data.deterministicClock, true);
  assert.deepEqual(result.data.supportedNodeTypes, Object.keys(catalog.types).sort());
  assert.equal(result.data.limits.maxSpeed, 7200);
  assert.equal(result.data.limits.maxRunSeconds, 31536000);
  assert.equal(result.data.persistence.available, true);
  assert.ok(result.data.methods.includes('setPlan'));
  assert.ok(result.data.methods.includes('setBillingInputs'));
});

test('validate is strict, structured, and non-mutating', () => {
  const host = makeHost();
  const sim = API.createAgentApi(host);
  const before = host.getScenario();
  const raw = candidate();
  raw.preview = true;
  const original = clone(raw);
  const result = sim.validate(raw);
  assert.equal(result.ok, true);
  assert.equal(result.data.valid, true);
  assert.equal(result.data.scenario.preview, true);
  assert.equal(result.data.warnings.length, 1);
  assert.deepEqual(raw, original);
  assert.deepEqual(host.getScenario(), before);
  assert.equal(host.loadCalls(), 0);
  result.data.scenario.nodes[0].p.rate = 999;
  assert.equal(raw.nodes[0].p.rate, 10);

  const cases = [
    [{ version: 2, nodes: [] }, API.ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION],
    [{ version: 1, nodes: [{ id: 'q', type: 'quantum_lb' }], edges: [] }, API.ERROR_CODES.UNSUPPORTED_NODE_TYPE],
    [{ version: 1, nodes: [{ id: 'a', type: 'traffic', p: { replicas: 3 } }], edges: [] }, API.ERROR_CODES.UNSUPPORTED_PARAMETER],
    [{ version: 1, nodes: [{ id: 'a', type: 'traffic', p: { rate: 0 } }], edges: [] }, API.ERROR_CODES.PARAMETER_OUT_OF_RANGE]
  ];
  cases.forEach(([value, code]) => {
    const invalid = sim.validate(value);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, code);
  });
  assert.equal(host.loadCalls(), 0);
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
  assert.equal(result.data.runId, 'run-000002');
  assert.equal(result.data.dirty, true);
  assert.equal(host.loadCalls(), 1);
});

test('loadScenario fails closed without partial mutation', () => {
  const host = makeHost();
  const sim = API.createAgentApi(host);
  const before = host.getScenario();
  const cases = [
    [null, API.ERROR_CODES.INVALID_SCENARIO],
    [{ version: 2, nodes: [] }, API.ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION],
    [{ version: 1, nodes: {} }, API.ERROR_CODES.INVALID_SCENARIO],
    [{ version: 1, nodes: [{ id: '__proto__', type: 'traffic' }], edges: [] }, API.ERROR_CODES.INVALID_SCENARIO],
    [{ version: 1, nodes: [{ id: 'q', type: 'quantum_lb' }], edges: [] }, API.ERROR_CODES.UNSUPPORTED_NODE_TYPE],
    [{ version: 1, nodes: [{ id: 'a', type: 'traffic', p: { replicas: 3 } }], edges: [] }, API.ERROR_CODES.UNSUPPORTED_PARAMETER],
    [{ version: 1, nodes: [{ id: 'a', type: 'traffic', p: { rate: 0 } }], edges: [] }, API.ERROR_CODES.PARAMETER_OUT_OF_RANGE],
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
  assert.equal(result.error.code, API.ERROR_CODES.UNSUPPORTED_NODE_TYPE);
  assert.deepEqual(result.error.details.nodes, [{ id: 'future', type: 'quantum_lb' }]);
  assert.deepEqual(host.getScenario(), before);
  assert.equal(host.loadCalls(), 0);
});

test('non-strict loads preserve unsupported content and invalid options fail closed', () => {
  const host = makeHost();
  const sim = API.createAgentApi(host);
  const raw = {
    version: 2,
    nodes: [{ id: 'q', type: 'quantum_lb', p: { replicas: 3 } }],
    edges: []
  };
  const loaded = sim.loadScenario(raw, { strict: false });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.data.scenario.version, 1);
  assert.equal(loaded.data.unsupported.length, 1);
  assert.equal(loaded.data.scenario.nodes[0].type, 'quantum_lb');
  assert.equal(loaded.data.scenario.nodes[0].p.replicas, 3);

  const before = host.getScenario();
  [{ strict: 'yes' }, { persist: 1 }, { unknown: true }].forEach(options => {
    const result = sim.loadScenario(candidate(), options);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, API.ERROR_CODES.INVALID_OPTIONS);
    assert.deepEqual(host.getScenario(), before);
  });
});

test('loadScenario resetRuntime defaults on and false preserves runtime only', () => {
  const host = makeHost();
  const sim = API.createAgentApi(host);
  Object.assign(host.runtime, {
    time: 42, running: true, speed: 99, plan: 'custom', budget: 123, baseFee: 7,
    spent: 2, requests: 4, requestCount: 4, modelSpent: 1, chaos: { m429: 50 }
  });
  host.runtime.nodes.queue.backlog = 12;
  host.runtime.nodes.queue.drops = 3;
  const before = host.getSimulation();
  const raw = candidate();
  raw.name = 'Runtime preserved';
  const loaded = sim.loadScenario(raw, { resetRuntime: false });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.data.runId, 'run-000002');
  const after = host.getSimulation();
  ['time', 'running', 'speed', 'plan', 'budget', 'baseFee', 'spent', 'requests', 'requestCount', 'modelSpent', 'chaos', 'nodes']
    .forEach(key => assert.deepEqual(after[key], before[key], key));
  assert.equal(host.getScenario().name, 'Runtime preserved');

  const reset = sim.loadScenario(candidate());
  assert.equal(reset.ok, true);
  assert.equal(reset.data.runId, 'run-000003');
  assert.equal(host.getSimulation().running, false);
  assert.equal(host.getSimulation().time, 0);
  assert.equal(host.getSimulation().requests, 0);
  assert.deepEqual(host.getSimulation().chaos, {});
  assert.equal(host.getSimulation().nodes.queue.backlog, 0);
  assert.equal(host.getSimulation().speed, 99);
});

test('persisted loads install only after a successful save', async () => {
  const host = makeHost();
  const sim = API.createAgentApi(host);
  const raw = candidate();
  raw.name = 'Persisted candidate';
  const loaded = await sim.loadScenario(raw, { persist: true });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.data.save.revision, 8);
  assert.equal(loaded.data.dirty, false);
  assert.equal(host.getScenario().name, 'Persisted candidate');

  const before = host.getScenario();
  host.saveScenario = async () => ({
    error: { code: 'SAVE_FAILED', message: 'disk full', details: { status: 500 } }
  });
  const failed = await sim.loadScenario(raw, { persist: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'SAVE_FAILED');
  assert.deepEqual(host.getScenario(), before);
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
    ['source', { rate: 20, unsupported: 1 }, API.ERROR_CODES.UNSUPPORTED_PARAMETER],
    ['source', { rate: 20, concurrency: -1 }, API.ERROR_CODES.PARAMETER_OUT_OF_RANGE],
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

test('setPlan recomputes Free, Paid, and Custom billing and allowance semantics', () => {
  const host = makeHost();
  const daysPerMonth = PRICING.hoursPerMonth / 24;
  const usage = {
    workersRequests: 15000000,
    workersCpuMs: 26280000000,
    cpuMsPerRequest: 12,
    doRequests: 1500000
  };
  Object.assign(host.runtime, {
    usage, rate: 0.01, time: 42, spent: 3, requests: 7, requestCount: 7
  });
  const sim = API.createAgentApi(host);
  const scenario = host.getScenario();
  const runId = host.getIdentity().runId;

  const free = sim.setPlan('free');
  assert.equal(free.ok, true);
  assert.deepEqual(free.data, sim.getState().data);
  const freeState = free.data;
  const freeById = id => freeState.cloudflare.allowances.find(item => item.id === id);
  assert.equal(freeState.plan, 'free');
  assert.equal(freeState.monthly.plan, 'free');
  assert.equal(freeState.monthly.total, 0);
  assert.equal(freeById('workersRequests').unit, 'requests/day');
  assert.equal(freeById('workersRequests').period, 'per day');
  assert.equal(freeById('workersRequests').used, 15000000 / daysPerMonth);
  assert.equal(freeById('workersRequests').included, 100000);
  assert.equal(freeById('workersRequests').exceeded, true);
  assert.equal(freeById('workersRequests').billable, 0);
  assert.equal(freeById('workersRequests').cost, 0);
  assert.equal(freeById('workersCpuMs').unit, 'CPU-ms/request');
  assert.equal(freeById('workersCpuMs').period, 'per request');
  assert.equal(freeById('workersCpuMs').used, 12);
  assert.equal(freeById('workersCpuMs').included, 10);
  assert.equal(freeById('workersCpuMs').exceeded, true);
  assert.equal(freeById('workersCpuMs').billable, 0);
  assert.equal(freeById('workersCpuMs').cost, 0);
  assert.deepEqual(freeState.cloudflare.exceeded.map(item => item.id), ['workersRequests', 'workersCpuMs']);

  const paid = sim.setPlan('paid');
  assert.equal(paid.ok, true);
  assert.deepEqual(paid.data, sim.getState().data);
  const paidState = paid.data;
  const paidById = id => paidState.cloudflare.allowances.find(item => item.id === id);
  assert.equal(paidState.plan, 'paid');
  assert.equal(paidState.monthly.plan, 'paid');
  assert.equal(paidById('workersRequests').unit, 'requests/month');
  assert.equal(paidById('workersRequests').period, 'per month');
  assert.equal(paidById('workersRequests').billable, 5000000);
  assert.equal(paidById('workersRequests').cost, 1.5);
  assert.equal(paidById('workersCpuMs').over, 26250000000);
  assert.equal(paidById('workersCpuMs').exceeded, true);
  assert.equal(paidById('workersCpuMs').billable, 26250000000);
  assert.equal(paidById('workersCpuMs').cost, 525);
  assert.equal(paidById('doRequests').billable, 1000000);
  assert.equal(paidById('doRequests').cost, 0.15);
  assert.equal(paidState.monthly.total, 531.65);
  assert.deepEqual(paidState.cloudflare.exceeded.map(item => item.id), ['workersRequests', 'workersCpuMs', 'doRequests']);

  const custom = sim.setPlan('custom');
  assert.equal(custom.ok, true);
  assert.deepEqual(custom.data, sim.getState().data);
  const customState = custom.data;
  const customById = id => customState.cloudflare.allowances.find(item => item.id === id);
  assert.equal(customState.plan, 'custom');
  assert.equal(customState.monthly.plan, 'custom');
  assert.equal(customState.monthly.total, PRICING.monthlyUsage(0.01));
  assert.equal(customById('workersRequests').included, null);
  assert.equal(customById('workersRequests').over, null);
  assert.equal(customById('workersRequests').exceeded, null);
  assert.equal(customById('workersRequests').billable, null);
  assert.equal(customById('workersRequests').cost, null);
  assert.deepEqual(customState.cloudflare.exceeded, []);
  assert.deepEqual(customState.scenario, scenario);
  assert.equal(customState.runId, runId);
  assert.equal(customState.time, 42);
  assert.equal(customState.simulation.spent, 3);
  assert.equal(customState.requestCount, 7);
  assert.equal(customState.dirty, false);
  assert.equal(customState.scenarioRevision, 7);
});

test('setPlan rejects invalid values without changing state', () => {
  const host = makeHost();
  const sim = API.createAgentApi(host);
  const before = sim.getState().data;
  ['FREE', 'enterprise', '', null, undefined, 1, {}, []].forEach(plan => {
    const result = sim.setPlan(plan);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, API.ERROR_CODES.INVALID_PARAMS);
    assert.deepEqual(sim.getState().data, before);
  });
});

test('setBillingInputs updates Custom atomically and rejects invalid patches', () => {
  const host = makeHost();
  host.runtime.rate = 0.01;
  const sim = API.createAgentApi(host);
  sim.setPlan('custom');
  const updated = sim.setBillingInputs({ baseFee: 25, budget: 100 });
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.data, sim.getState().data);
  assert.equal(updated.data.plan, 'custom');
  assert.equal(updated.data.baseFee, 25);
  assert.equal(updated.data.budget, 100);
  assert.equal(updated.data.monthly.base, 25);
  assert.equal(updated.data.monthly.total, 25 + PRICING.monthlyUsage(0.01));

  const before = sim.getState().data;
  const invalid = [
    [null, API.ERROR_CODES.INVALID_PARAMS],
    [[], API.ERROR_CODES.INVALID_PARAMS],
    [{}, API.ERROR_CODES.INVALID_PARAMS],
    [{ rateMonthly: 1 }, API.ERROR_CODES.UNSUPPORTED_PARAMETER],
    [{ baseFee: 10, budget: 100, extra: true }, API.ERROR_CODES.UNSUPPORTED_PARAMETER],
    [{ baseFee: -1 }, API.ERROR_CODES.PARAMETER_OUT_OF_RANGE],
    [{ baseFee: 10, budget: 0 }, API.ERROR_CODES.PARAMETER_OUT_OF_RANGE],
    [{ baseFee: '10' }, API.ERROR_CODES.INVALID_PARAMS],
    [{ budget: Number.NaN }, API.ERROR_CODES.INVALID_PARAMS],
    [{ baseFee: Infinity }, API.ERROR_CODES.INVALID_PARAMS]
  ];
  invalid.forEach(([patch, code]) => {
    const result = sim.setBillingInputs(patch);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.deepEqual(sim.getState().data, before);
  });
});

test('start, setSpeed, pause, and invalid controls validate before mutating state', () => {
  const host = makeHost();
  const sim = API.createAgentApi(host);
  const started = sim.start({ speed: 120 });
  assert.deepEqual(started.data, {
    running: true, speed: 120, time: 0, runId: 'run-000001', scenarioRevision: 7,
    scenarioHash: 'sha256-initial', dirty: false, saving: false, saveError: null
  });
  const before = sim.getState().data.simulation;
  [0, 7201, 1.5, { speed: 60, reset: true }, 'fast'].forEach(options => {
    const result = sim.start(options);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, API.ERROR_CODES.INVALID_OPTIONS);
    assert.deepEqual(sim.getState().data.simulation, before);
  });
  assert.equal(sim.setSpeed(240).data.speed, 240);
  assert.equal(sim.setSpeed(0).error.code, API.ERROR_CODES.INVALID_PARAMS);
  assert.equal(sim.pause().data.running, false);
  assert.equal(sim.reset().data.time, 0);
});

test('run advances exact simulated time and produces identical state for equal inputs', () => {
  const first = makeHost();
  const second = makeHost();
  const a = API.createAgentApi(first);
  const b = API.createAgentApi(second);
  a.loadScenario(candidate());
  b.loadScenario(candidate());
  const beforeA = a.getState().data;
  const beforeB = b.getState().data;
  assert.deepEqual(beforeA, beforeB);
  assert.equal(a.run({ seconds: 10 }).data.time, 10);
  assert.equal(b.run({ seconds: 10 }).data.time, 10);
  assert.deepEqual(a.getState().data, b.getState().data);
  const state = a.getState().data;
  const expected = ENGINE.step(0, 10, 1, 10, 100);
  assert.equal(state.requestCount, 100);
  assert.equal(state.nodes.queue.backlog, expected.backlog);
  assert.equal(state.nodes.queue.drops, expected.drops);
  assert.equal(state.running, false);

  const beforeInvalid = a.getState().data;
  [{}, { seconds: 0 }, { seconds: -1 }, { seconds: Infinity }, { seconds: 31536001 }, { seconds: 1, extra: true }]
    .forEach(options => {
      const result = a.run(options);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, API.ERROR_CODES.INVALID_OPTIONS);
      assert.deepEqual(a.getState().data, beforeInvalid);
    });
});

test('reset changes run identity and clears runtime without changing architecture or storage state', () => {
  const host = makeHost();
  const sim = API.createAgentApi(host);
  sim.setSpeed(180);
  sim.start();
  sim.run({ seconds: 5 });
  const scenario = sim.exportScenario().data;
  const identity = sim.getState().data;
  const reset = sim.reset();
  assert.equal(reset.ok, true);
  assert.notEqual(reset.data.runId, identity.runId);
  assert.equal(reset.data.running, false);
  assert.equal(reset.data.time, 0);
  assert.equal(reset.data.speed, 180);
  assert.deepEqual(sim.exportScenario().data, scenario);
  const state = sim.getState().data;
  assert.equal(state.requestCount, 0);
  assert.equal(state.nodes.queue.backlog, 0);
  assert.equal(state.nodes.queue.drops, 0);
  assert.equal(state.dirty, identity.dirty);
  assert.equal(state.saveError, identity.saveError);
});

test('save clears dirty only after a successful response', async () => {
  const host = makeHost();
  const sim = API.createAgentApi(host);
  sim.setParams('source', { rate: 20 });
  assert.equal(sim.getState().data.dirty, true);
  let resolveSave;
  const save = host.saveScenario;
  host.saveScenario = scenario => new Promise(resolve => {
    resolveSave = async () => resolve(await save(scenario));
  });
  const pending = sim.save();
  assert.equal(sim.getState().data.dirty, true);
  resolveSave();
  const saved = await pending;
  assert.equal(saved.ok, true);
  assert.equal(saved.data.revision, 8);
  assert.equal(saved.data.hash, 'sha256-1');
  assert.equal(sim.getState().data.dirty, false);
  assert.equal(sim.getState().data.scenarioRevision, 8);
  assert.equal(sim.getState().data.saveError, null);
});

test('a save cannot clear a newer dirty edit', async () => {
  const host = makeHost();
  const sim = API.createAgentApi(host);
  sim.setParams('source', { rate: 20 });
  let resolveSave;
  const save = host.saveScenario;
  host.saveScenario = scenario => new Promise(resolve => {
    resolveSave = async () => resolve(await save(scenario));
  });
  const pending = sim.save();
  sim.setParams('source', { rate: 30 });
  resolveSave();
  assert.equal((await pending).ok, true);
  assert.equal(sim.getState().data.dirty, true);
  assert.equal(sim.exportScenario().data.nodes[0].p.rate, 30);
});

test('save failures keep dirty state and expose structured errors', async () => {
  const codes = ['SAVE_FAILED', 'CHANNEL_UNAVAILABLE', 'STORAGE_CONFLICT'];
  for (const code of codes) {
    const host = makeHost();
    const sim = API.createAgentApi(host);
    sim.setParams('source', { rate: 20 });
    const error = { code, message: code.toLowerCase(), details: { status: code === 'STORAGE_CONFLICT' ? 409 : 500 } };
    host.saveScenario = async () => host.failSave(error);
    const result = await sim.save();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    const state = sim.getState().data;
    assert.equal(state.dirty, true);
    assert.equal(state.saveError.code, code);
  }
});

test('getState includes complete identity, runtime, billing, model, node, and diagnostic fields', () => {
  const host = makeHost();
  const result = API.createAgentApi(host).getState();
  assert.equal(result.ok, true);
  const state = result.data;
  ['apiVersion', 'schemaVersion', 'modelVersion', 'scenarioRevision', 'runId', 'time', 'running', 'speed',
    'plan', 'budget', 'baseFee', 'requestCount', 'dirty', 'saving', 'saveError'].forEach(key => {
    assert.ok(Object.hasOwn(state, key), key);
  });
  assert.equal(state.apiVersion, 1);
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.modelVersion, 'rate-v1');
  assert.equal(state.scenario.name, 'Agent candidate');
  assert.equal(state.simulation.speed, 60);
  assert.equal(state.plan, 'paid');
  assert.deepEqual(state.usage, { workersRequests: 1000, queueOps: 3000 });
  assert.equal(state.monthly.plan, 'paid');
  assert.equal(state.units.time, 'simulated seconds');
  assert.equal(state.cloudflare.units.workersRequests.unit, 'requests/month');
  assert.equal(state.cloudflare.allowances.length, PRICING.dims.length);
  assert.ok(Array.isArray(state.cloudflare.exceeded));
  assert.ok(Array.isArray(state.cloudflare.unverified));
  assert.equal(state.cloudflare.overage, state.monthly.overage);
  assert.deepEqual(Object.keys(state.model).sort(), ['accumulated', 'monthly', 'perRequest', 'priceInputs', 'set', 'units'].sort());
  assert.equal(state.model.monthly, 0);
  assert.equal(state.model.accumulated, 0);
  assert.equal(state.model.perRequest, null);
  assert.equal(state.model.priceInputs.length, 1);
  assert.equal(state.nodes.queue.backlog, 900);
  assert.equal(state.nodes.queue.drops, 9);
  assert.equal(state.nodes.queue.units.drops, 'messages/s');
  assert.equal(Object.hasOwn(state.nodes.queue, 'billedRequests'), false);
  assert.equal(state.nodes.state.billedRequests, 1);
  assert.equal(state.nodes.state.doGbS, 100);
  assert.equal(state.nodes.state.objects, 1);
  assert.equal(state.nodes.state.perObjectRate, 1);
  assert.equal(state.nodes.state.objectLimit, 1000);
  assert.equal(state.nodes.state.overloaded, true);
  assert.equal(Object.hasOwn(state.nodes.state, 'backlog'), false);
  assert.ok(state.assumptions.find(item => item.id === 'requestsPerUserPerMonth').classification.includes('assumption'));
  assert.equal(state.provenance.pricing.asOf, PRICING.asOf);
  assert.equal(state.provenance.pricing.hoursPerMonth, PRICING.hoursPerMonth);
  assert.deepEqual(state.provenance.pricing.sources, PRICING.sources);
  assert.equal(state.provenance.nodes.api.verified, true);
  assert.equal(state.provenance.nodes.api.source, catalog.types.workers.doc);
  assert.equal(state.provenance.nodes.api.params.latency.classification, 'editable_model_assumption');
  assert.ok(Array.isArray(state.diagnostics.warnings));
  assert.ok(Array.isArray(state.unsupported));
  assert.ok(Array.isArray(state.assumptions));
  assert.ok(Array.isArray(state.limitations));
  const codes = state.warnings.map(item => item.code);
  ['QUEUE_BACKLOG', 'QUEUE_EXPIRY', 'DURABLE_OBJECT_OVERLOAD', 'MODEL_SPEND_UNSET'].forEach(code => {
    assert.ok(codes.includes(code), code);
  });
});

test('paid allowance metadata uses monthly units and derives exceeded from overage', () => {
  const host = makeHost();
  const usage = {
    workersRequests: 15000000,
    workersCpuMs: 26280000000,
    doRequests: 1500000
  };
  Object.assign(host.runtime, {
    plan: 'paid',
    usage,
    monthly: PRICING.monthlyCost('paid', usage)
  });
  const state = API.createAgentApi(host).getState().data;
  const byId = id => state.cloudflare.allowances.find(item => item.id === id);
  const cpu = byId('workersCpuMs');
  assert.equal(cpu.unit, 'CPU-ms/month');
  assert.equal(cpu.period, 'per month');
  assert.equal(cpu.used, 26280000000);
  assert.equal(cpu.included, 30000000);
  assert.equal(cpu.over, 26250000000);
  assert.equal(cpu.exceeded, true);
  assert.equal(cpu.billable, 26250000000);
  assert.equal(cpu.cost, 525);
  const requests = byId('workersRequests');
  assert.equal(requests.unit, 'requests/month');
  assert.equal(requests.period, 'per month');
  assert.equal(requests.exceeded, true);
  assert.equal(requests.billable, 5000000);
  assert.equal(requests.cost, 1.5);
  const objects = byId('doRequests');
  assert.equal(objects.billable, 1000000);
  assert.equal(objects.cost, 0.15);
  assert.deepEqual(state.cloudflare.exceeded.map(item => item.id), ['workersRequests', 'workersCpuMs', 'doRequests']);
});

test('free allowance metadata preserves per-request and daily semantics', () => {
  const host = makeHost();
  const daysPerMonth = PRICING.hoursPerMonth / 24;
  const usage = {
    workersRequests: 100000 * daysPerMonth,
    workersCpuMs: 12 * 100000 * daysPerMonth,
    cpuMsPerRequest: 12
  };
  Object.assign(host.runtime, {
    plan: 'free',
    usage,
    monthly: PRICING.monthlyCost('free', usage)
  });
  const state = API.createAgentApi(host).getState().data;
  const byId = id => state.cloudflare.allowances.find(item => item.id === id);
  const requests = byId('workersRequests');
  assert.equal(requests.unit, 'requests/day');
  assert.equal(requests.period, 'per day');
  assert.equal(requests.used, 100000);
  assert.equal(requests.included, 100000);
  assert.equal(requests.exceeded, false);
  const cpu = byId('workersCpuMs');
  assert.equal(cpu.unit, 'CPU-ms/request');
  assert.equal(cpu.period, 'per request');
  assert.equal(cpu.used, 12);
  assert.equal(cpu.included, 10);
  assert.equal(cpu.exceeded, true);
});

test('custom allowance metadata marks unallocated billable and cost as not applicable', () => {
  const host = makeHost();
  const usage = {
    workersRequests: 15000000,
    workersCpuMs: 105000000,
    doRequests: 1500000
  };
  const rateMonthly = PRICING.dims.reduce((total, dim) => {
    return total + (usage[dim.id] || 0) / dim.unit * dim.price;
  }, 0);
  Object.assign(host.runtime, {
    plan: 'custom',
    baseFee: 10,
    usage,
    monthly: PRICING.monthlyCost('custom', Object.assign({ rateMonthly, baseFee: 10 }, usage))
  });
  const state = API.createAgentApi(host).getState().data;
  const byId = id => state.cloudflare.allowances.find(item => item.id === id);
  const requests = byId('workersRequests');
  assert.equal(requests.unit, 'requests/month');
  assert.equal(requests.period, 'per month');
  assert.equal(requests.included, null);
  assert.equal(requests.over, null);
  assert.equal(requests.exceeded, null);
  assert.equal(requests.billable, null);
  assert.equal(requests.cost, null);
  assert.equal(requests.allowanceStatus, 'not_applicable');
  assert.match(requests.reason, /aggregate live rate/);
  assert.equal(byId('workersCpuMs').billable, null);
  assert.equal(byId('workersCpuMs').cost, null);
  assert.equal(state.cloudflare.monthly.total, 10 + rateMonthly);
  assert.deepEqual(state.cloudflare.exceeded, []);
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
  assert.ok(codes.includes('UNSUPPORTED_CONTENT'));
});

test('exportScenario is canonical, isolated, and can include assessment and provenance', () => {
  const host = makeHost();
  const sim = API.createAgentApi(host);
  const first = sim.exportScenario();
  assert.equal(first.ok, true);
  const canonical = JSON.stringify(first.data);
  first.data.nodes[0].p.rate = 999;
  assert.equal(JSON.stringify(sim.exportScenario().data), canonical);
  const loaded = sim.loadScenario(sim.exportScenario().data);
  assert.equal(JSON.stringify(loaded.data.scenario), canonical);
  const assessment = sim.exportScenario({ assessment: true, provenance: true });
  assert.equal(assessment.ok, true);
  assert.equal(assessment.data.assessment.cloudflare.allowances.length, PRICING.dims.length);
  assert.equal(assessment.data.assessment.model.priceInputs.length, 1);
  assert.equal(assessment.data.provenance.asOf, PRICING.asOf);
});

test('invalid host state, oversized scenarios, and unexpected failures use structured errors', () => {
  const host = makeHost();
  host.getScenario = () => null;
  const invalid = API.createAgentApi(host).getState();
  assert.equal(invalid.error.code, API.ERROR_CODES.INVALID_STATE);

  const oversized = { version: 1, nodes: [], edges: [], padding: 'x'.repeat(API.LIMITS.maxScenarioBytes) };
  const tooBig = API.createAgentApi(makeHost()).validate(oversized);
  assert.equal(tooBig.error.code, API.ERROR_CODES.INVALID_SCENARIO);
  const circular = { version: 1, nodes: [], edges: [] };
  circular.self = circular;
  assert.equal(API.createAgentApi(makeHost()).validate(circular).error.code, API.ERROR_CODES.INVALID_SCENARIO);

  const broken = makeHost();
  broken.getScenario = () => { throw new Error('host exploded'); };
  const internal = API.createAgentApi(broken).getState();
  assert.equal(internal.ok, false);
  assert.equal(internal.error.code, API.ERROR_CODES.INTERNAL_ERROR);
  assert.equal(internal.error.details.message, 'host exploded');
});
