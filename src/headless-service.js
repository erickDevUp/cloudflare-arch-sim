(function (root, factory) {
  const core = root && root.SIM_STATE_CORE || typeof globalThis !== 'undefined' && globalThis.SIM_STATE_CORE;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SIM_HEADLESS = api;
})(typeof window !== 'undefined' ? window : null, function (CORE) {
  'use strict';

  if (!CORE) throw new Error('Headless simulator state core is missing');

  const hasOwn = (value, key) => Object.hasOwn(value, key);
  const clone = value => JSON.parse(JSON.stringify(value));

  function createHeadlessSimulator(options) {
    if (!options || !options.scenario || !options.catalog || !options.pricing || !options.engine || !options.agentApi) {
      throw new Error('Headless simulator dependencies are incomplete');
    }
    const { scenario: scenarioModule, catalog, pricing, engine, agentApi, defaultScenario } = options;
    const requestsPerUserPerMonth = options.requestsPerUserPerMonth == null ? 100 : options.requestsPerUserPerMonth;
    const validated = agentApi.validateScenario(defaultScenario, { scenario: scenarioModule, catalog }, { strict: true });
    if (validated.error) throw new Error(validated.error.message);

    let currentScenario = clone(validated.scenario);
    let runSeq = 0;
    const nextRunId = () => 'run-' + String(++runSeq).padStart(6, '0');
    const identity = {
      scenarioRevision: null,
      scenarioHash: null,
      runId: nextRunId(),
      dirty: true,
      saving: false,
      saveError: null
    };
    const runtime = {
      time: 0,
      running: false,
      speed: 60,
      plan: 'paid',
      baseFee: 0,
      budget: 5000,
      spent: 0,
      requests: 0,
      requestCount: 0,
      modelSpent: 0,
      chaos: {},
      backlog: {},
      drops: {},
      res: {},
      cpuRate: 0,
      rate: 0,
      pathLat: 0,
      usage: {},
      monthly: pricing.monthlyCost('paid', {}),
      modelSpend: pricing.modelSpend([])
    };

    function knownNodes(scenario) {
      return scenario.nodes.filter(node => hasOwn(catalog.types, node.type));
    }

    function calculate(scenario, backlog, drops) {
      const nodes = knownNodes(scenario);
      const params = Object.fromEntries(nodes.map(node => [node.id, node.p]));
      const model = engine.compute(nodes, scenario.edges, catalog.types, params, backlog, drops, pricing.hoursPerMonth);
      const usage = engine.usage(nodes, model.res, params, pricing.hoursPerMonth);
      const modelSpend = pricing.modelSpend(nodes
        .filter(node => node.type === 'external_model')
        .map(node => ({ p: node.p, lambda: (model.res[node.id] || {}).lambda || 0 })));
      const monthly = pricing.monthlyCost(runtime.plan, Object.assign({}, usage, {
        baseFee: runtime.baseFee,
        rateMonthly: pricing.monthlyUsage(model.rate)
      }));
      return { model, usage, modelSpend, monthly };
    }

    function applyCalculation(target, calculation) {
      target.res = calculation.model.res;
      target.cpuRate = calculation.model.cpuRate;
      target.rate = calculation.model.rate;
      target.pathLat = calculation.model.pathLat;
      target.usage = calculation.usage;
      target.monthly = calculation.monthly;
      target.modelSpend = calculation.modelSpend;
    }

    function refreshBilling() {
      runtime.monthly = pricing.monthlyCost(runtime.plan, Object.assign({}, runtime.usage, {
        baseFee: runtime.baseFee,
        rateMonthly: pricing.monthlyUsage(runtime.rate)
      }));
    }

    function clearRuntime(target) {
      target.time = 0;
      target.running = false;
      target.spent = 0;
      target.requests = 0;
      target.requestCount = 0;
      target.modelSpent = 0;
      target.chaos = {};
      target.backlog = {};
      target.drops = {};
    }

    function markDirty() {
      CORE.markDirty(identity);
    }

    function sourceRate() {
      return knownNodes(currentScenario).reduce((total, node) => {
        return total + (catalog.types[node.type].source ? node.p.rate || 0 : 0);
      }, 0);
    }

    function simulationSnapshot() {
      return clone(CORE.simulationSnapshot(runtime, knownNodes(currentScenario), identity));
    }

    function installScenario(scenario, options) {
      const resetRuntime = !options || options.resetRuntime !== false;
      const backlog = {};
      const drops = {};
      if (!resetRuntime) {
        knownNodes(scenario).filter(node => node.type === 'queues').forEach(node => {
          backlog[node.id] = runtime.backlog[node.id] || 0;
          drops[node.id] = runtime.drops[node.id] || 0;
        });
      }
      const calculation = calculate(scenario, backlog, drops);
      currentScenario = clone(scenario);
      if (resetRuntime) clearRuntime(runtime);
      runtime.backlog = backlog;
      runtime.drops = drops;
      applyCalculation(runtime, calculation);
      identity.runId = nextRunId();
      markDirty();
    }

    function setParams(nodeId, patch) {
      const scenario = clone(currentScenario);
      const node = scenario.nodes.find(item => item.id === nodeId);
      node.p = Object.assign({}, node.p, patch);
      const calculation = calculate(scenario, runtime.backlog, runtime.drops);
      currentScenario = scenario;
      applyCalculation(runtime, calculation);
      markDirty();
      return { nodeId, params: clone(node.p) };
    }

    function setPlan(plan) {
      runtime.plan = plan;
      refreshBilling();
    }

    function setBillingInputs(patch) {
      Object.assign(runtime, patch);
      refreshBilling();
    }

    function reset() {
      clearRuntime(runtime);
      const calculation = calculate(currentScenario, runtime.backlog, runtime.drops);
      applyCalculation(runtime, calculation);
      identity.runId = nextRunId();
    }

    function run(seconds) {
      const target = clone(runtime);
      target.running = false;
      engine.advanceClock(target, seconds, dt => {
        knownNodes(currentScenario).filter(node => node.type === 'queues').forEach(node => {
          const previous = target.res[node.id] || {};
          const capacity = engine.capacity(node.p);
          const next = engine.step(target.backlog[node.id] || 0, previous.lambda || 0, capacity, dt, node.p.retention);
          target.backlog[node.id] = next.backlog;
          target.drops[node.id] = next.drops;
        });
        return {
          rate: target.rate,
          requests: sourceRate(),
          modelRate: target.modelSpend.set ? target.modelSpend.total / (3600 * pricing.hoursPerMonth) : 0
        };
      }, () => {
        applyCalculation(target, calculate(currentScenario, target.backlog, target.drops));
      });
      target.requestCount = target.requests;
      Object.assign(runtime, target);
    }

    const initial = calculate(currentScenario, runtime.backlog, runtime.drops);
    applyCalculation(runtime, initial);

    return agentApi.createAgentApi({
      scenario: scenarioModule,
      catalog,
      pricing,
      getScenario: () => clone(currentScenario),
      getSimulation: simulationSnapshot,
      getIdentity: () => clone(identity),
      getModel: () => ({ requestsPerUserPerMonth, engine: Object.assign({}, engine.MODEL) }),
      loadScenario: installScenario,
      setParams,
      setPlan,
      setBillingInputs,
      start: speed => {
        if (speed !== undefined) runtime.speed = speed;
        runtime.running = true;
      },
      pause: () => { runtime.running = false; },
      reset,
      run,
      setSpeed: speed => { runtime.speed = speed; },
      saveScenario: () => ({
        error: { code: 'CHANNEL_UNAVAILABLE', message: 'MCP v1 does not persist scenarios' }
      }),
      getChannelStatus: () => ({
        available: false,
        saving: false,
        revision: null,
        hash: null,
        transport: 'stdio'
      })
    });
  }

  return { createHeadlessSimulator };
});
