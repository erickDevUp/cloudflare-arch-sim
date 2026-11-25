(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SIM_API_FACTORY = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const VERSION = 1;
  const ERROR_CODES = Object.freeze({
    INVALID_SCENARIO: 'INVALID_SCENARIO',
    UNSUPPORTED_NODE: 'UNSUPPORTED_NODE',
    UNKNOWN_NODE: 'UNKNOWN_NODE',
    INVALID_PARAMS: 'INVALID_PARAMS',
    INVALID_STATE: 'INVALID_STATE',
    INTERNAL_ERROR: 'INTERNAL_ERROR'
  });
  const hasOwn = (value, key) => Object.hasOwn(value, key);
  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const unsafeName = value => typeof value === 'string' && (value === '__proto__' || value in Object.prototype);
  const clone = value => JSON.parse(JSON.stringify(value));

  function success(requestId, data) {
    return { ok: true, data, requestId };
  }

  function failure(requestId, code, message, details) {
    const error = { code, message };
    if (details !== undefined) error.details = details;
    return { ok: false, error, requestId };
  }

  function request(seq, run) {
    const requestId = 'sim-v1-' + String(seq).padStart(6, '0');
    try {
      const result = run();
      if (result && result.error) return failure(requestId, result.error.code, result.error.message, result.error.details);
      return success(requestId, result.data);
    } catch (err) {
      return failure(requestId, ERROR_CODES.INTERNAL_ERROR, 'SIM_API request failed', {
        message: String((err && err.message) || err).split('\n')[0]
      });
    }
  }

  function validateScenario(raw, host) {
    if (!isObject(raw)) {
      return { error: { code: ERROR_CODES.INVALID_SCENARIO, message: 'Scenario must be an object' } };
    }
    if (raw.version !== undefined && raw.version !== VERSION) {
      return {
        error: {
          code: ERROR_CODES.INVALID_SCENARIO,
          message: 'Unsupported scenario version',
          details: { expected: VERSION, received: raw.version }
        }
      };
    }
    if (!Array.isArray(raw.nodes)) {
      return {
        error: {
          code: ERROR_CODES.INVALID_SCENARIO,
          message: 'Scenario nodes must be an array',
          details: { field: 'nodes' }
        }
      };
    }
    const validated = host.scenario.validate(raw, host.catalog);
    if (!validated.scenario || validated.dropped > 0) {
      return {
        error: {
          code: ERROR_CODES.INVALID_SCENARIO,
          message: validated.error || 'Scenario validation failed',
          details: { dropped: validated.dropped || 0 }
        }
      };
    }
    const scenario = validated.scenario;
    const unsafeIds = scenario.nodes.filter(node => unsafeName(node.id)).map(node => node.id);
    if (unsafeIds.length) {
      return {
        error: {
          code: ERROR_CODES.INVALID_SCENARIO,
          message: 'Scenario contains unsafe node ids',
          details: { nodeIds: unsafeIds }
        }
      };
    }
    const unsupported = scenario.nodes.filter(node => !hasOwn(host.catalog.types, node.type));
    if (unsupported.length) {
      return {
        error: {
          code: ERROR_CODES.UNSUPPORTED_NODE,
          message: 'Scenario contains unsupported node types',
          details: {
            nodes: unsupported.map(node => ({ id: node.id || null, type: node.type }))
          }
        }
      };
    }
    const invalidParams = [];
    scenario.nodes.forEach(node => {
      const allowed = ((host.catalog.types[node.type] || {}).p) || {};
      Object.keys(node.p || {}).forEach(key => {
        if (!hasOwn(allowed, key)) invalidParams.push({ nodeId: node.id, param: key });
      });
    });
    if (invalidParams.length) {
      return {
        error: {
          code: ERROR_CODES.INVALID_PARAMS,
          message: 'Scenario contains unsupported node params',
          details: { params: invalidParams }
        }
      };
    }
    return { scenario, warnings: validated.error ? [validated.error] : [] };
  }

  function validateParamPatch(nodeId, patch, scenario, catalog) {
    if (typeof nodeId !== 'string' || !nodeId || unsafeName(nodeId)) {
      return { error: { code: ERROR_CODES.UNKNOWN_NODE, message: 'Node id must be a safe non-empty string' } };
    }
    const node = (scenario.nodes || []).find(item => item.id === nodeId);
    if (!node || !hasOwn(catalog.types, node.type)) {
      return {
        error: {
          code: ERROR_CODES.UNKNOWN_NODE,
          message: 'Unknown node',
          details: { nodeId }
        }
      };
    }
    if (!isObject(patch) || !Object.keys(patch).length) {
      return {
        error: {
          code: ERROR_CODES.INVALID_PARAMS,
          message: 'Params patch must be a non-empty object',
          details: { nodeId }
        }
      };
    }
    const def = catalog.types[node.type];
    const allowed = def.p || {};
    const invalid = [];
    const safe = {};
    Object.keys(patch).forEach(key => {
      const value = patch[key];
      if (!hasOwn(allowed, key)) {
        invalid.push({ param: key, reason: 'unsupported' });
        return;
      }
      if (value === null && allowed[key] === null) {
        safe[key] = null;
        return;
      }
      if (catalog.enums[key]) {
        if (!catalog.enums[key].includes(value)) invalid.push({ param: key, reason: 'not an allowed value' });
        else safe[key] = value;
        return;
      }
      if (!finite(value)) {
        invalid.push({ param: key, reason: 'expected a finite number' });
        return;
      }
      const range = catalog.ranges[key];
      if (range && (value < range[0] || value > range[1])) {
        invalid.push({ param: key, reason: 'outside range', min: range[0], max: range[1] });
        return;
      }
      safe[key] = value;
    });
    if (invalid.length) {
      return {
        error: {
          code: ERROR_CODES.INVALID_PARAMS,
          message: 'Invalid node params',
          details: { nodeId, params: invalid }
        }
      };
    }
    return { patch: safe };
  }

  function validateStartOptions(options) {
    if (options === undefined) return { options: {} };
    if (!isObject(options)) {
      return { error: { code: ERROR_CODES.INVALID_PARAMS, message: 'Start options must be an object' } };
    }
    const unknown = Object.keys(options).filter(key => key !== 'speed');
    if (unknown.length) {
      return {
        error: {
          code: ERROR_CODES.INVALID_PARAMS,
          message: 'Unsupported start options',
          details: { options: unknown }
        }
      };
    }
    if (options.speed !== undefined && (!Number.isInteger(options.speed) || options.speed < 1 || options.speed > 7200)) {
      return {
        error: {
          code: ERROR_CODES.INVALID_PARAMS,
          message: 'Speed must be an integer from 1 through 7200',
          details: { speed: options.speed }
        }
      };
    }
    return { options: { speed: options.speed } };
  }

  function cycleNodes(scenario) {
    const nodes = new Map(scenario.nodes.map(node => [node.id, node]));
    const indegree = new Map(scenario.nodes.map(node => [node.id, 0]));
    const outgoing = new Map(scenario.nodes.map(node => [node.id, []]));
    scenario.edges.forEach(edge => {
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) return;
      indegree.set(edge.to, indegree.get(edge.to) + 1);
      outgoing.get(edge.from).push(edge.to);
    });
    const queue = scenario.nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id);
    const visited = new Set(queue);
    while (queue.length) {
      const id = queue.shift();
      outgoing.get(id).forEach(to => {
        indegree.set(to, indegree.get(to) - 1);
        if (indegree.get(to) === 0) {
          visited.add(to);
          queue.push(to);
        }
      });
    }
    return scenario.nodes.filter(node => !visited.has(node.id)).map(node => node.id);
  }

  function stateWarnings(scenario, simulation, catalog) {
    const warnings = [];
    const unsupported = scenario.nodes.filter(node => !hasOwn(catalog.types, node.type));
    if (unsupported.length) {
      warnings.push({
        code: 'UNSUPPORTED_NODE',
        message: 'Unsupported nodes are excluded from simulation',
        details: { nodes: unsupported.map(node => ({ id: node.id || null, type: node.type })) }
      });
    }
    const unknownParams = [];
    scenario.nodes.forEach(node => {
      const def = catalog.types[node.type];
      if (!def) return;
      Object.keys(node.p || {}).forEach(key => {
        if (!hasOwn(def.p || {}, key)) unknownParams.push({ nodeId: node.id, param: key });
      });
    });
    if (unknownParams.length) {
      warnings.push({
        code: 'UNKNOWN_PARAMS',
        message: 'Unknown params are preserved but not modeled',
        details: { params: unknownParams }
      });
    }
    const cyclic = cycleNodes(scenario);
    if (cyclic.length) {
      warnings.push({
        code: 'CYCLE_DETECTED',
        message: 'Cycle-dependent nodes receive zero traffic in the topological model',
        details: { nodeIds: cyclic }
      });
    }
    ((simulation.monthly && simulation.monthly.unverified) || []).forEach(id => {
      warnings.push({ code: 'UNVERIFIED_PRICING', message: 'Pricing dimension is unverified', details: { dimension: id } });
    });
    if (scenario.nodes.some(node => node.type === 'external_model') && simulation.modelSpend && !simulation.modelSpend.set) {
      warnings.push({
        code: 'MODEL_SPEND_UNSET',
        message: 'External model spend is unset until all token prices and counts are provided'
      });
    }
    Object.entries(simulation.nodes || {}).forEach(([id, node]) => {
      if (node.type === 'queues' && node.backlog > 0) {
        warnings.push({ code: 'QUEUE_BACKLOG', message: 'Queue has a backlog', details: { nodeId: id, backlog: node.backlog } });
      }
      if (node.type === 'queues' && node.drops > 0) {
        warnings.push({ code: 'QUEUE_EXPIRY', message: 'Queue is dropping expired messages', details: { nodeId: id, drops: node.drops } });
      }
      if (node.type === 'durable_objects' && node.overloaded) {
        warnings.push({ code: 'DURABLE_OBJECT_OVERLOAD', message: 'Durable Object is overloaded', details: { nodeId: id } });
      }
    });
    return warnings;
  }

  function buildSnapshot(simulation, scenario, host) {
    const catalog = host.catalog;
    const pricing = host.pricing;
    const model = host.getModel();
    const nodes = Object.fromEntries(scenario.nodes.map(node => {
      const def = catalog.types[node.type] || {};
      return [node.id, {
        type: node.type,
        verified: def.verified || null,
        source: def.doc || null,
        note: def.note || null,
        params: Object.fromEntries(Object.entries(node.p || {}).map(([key, value]) => [
          key, { value, classification: 'editable_model_assumption' }
        ]))
      }];
    }));
    return clone({
      version: VERSION,
      scenario,
      simulation: {
        time: simulation.time,
        running: simulation.running,
        speed: simulation.speed,
        spent: simulation.spent,
        rate: simulation.rate,
        pathLat: simulation.pathLat,
        requests: simulation.requests,
        modelSpent: simulation.modelSpent,
        cpuRate: simulation.cpuRate,
        baseFee: simulation.baseFee,
        budget: simulation.budget,
        chaos: simulation.chaos
      },
      plan: simulation.plan,
      usage: simulation.usage,
      monthly: simulation.monthly,
      modelSpend: simulation.modelSpend,
      nodes: simulation.nodes,
      assumptions: [
        {
          id: 'requestsPerUserPerMonth',
          value: model.requestsPerUserPerMonth,
          unit: 'requests/user/month',
          classification: 'editable_model_assumption'
        },
        {
          id: 'hoursPerMonth',
          value: pricing.hoursPerMonth,
          unit: 'hours/month',
          classification: 'verified_pricing_convention',
          source: 'src/pricing.js'
        }
      ],
      provenance: {
        pricing: {
          asOf: pricing.asOf,
          sources: pricing.sources,
          dimensions: pricing.dims
        },
        nodes
      },
      warnings: stateWarnings(scenario, simulation, catalog)
    });
  }

  function controlState(host) {
    const state = host.getSimulation();
    return { running: state.running, speed: state.speed, time: state.time };
  }

  function createAgentApi(host) {
    if (!host || !host.scenario || !host.catalog || !host.pricing || !host.getScenario ||
        !host.getSimulation || !host.getModel || !host.loadScenario || !host.setParams ||
        !host.start || !host.pause || !host.reset) {
      throw new Error('SIM_API host is incomplete');
    }
    let seq = 0;
    return {
      version: VERSION,
      loadScenario(raw) {
        return request(++seq, () => {
          const validated = validateScenario(raw, host);
          if (validated.error) return { error: validated.error };
          host.loadScenario(validated.scenario);
          return { data: { scenario: host.getScenario(), warnings: validated.warnings } };
        });
      },
      setParams(nodeId, patch) {
        return request(++seq, () => {
          const scenario = host.getScenario();
          if (!isObject(scenario) || !Array.isArray(scenario.nodes)) {
            return { error: { code: ERROR_CODES.INVALID_STATE, message: 'Current scenario is invalid' } };
          }
          const validated = validateParamPatch(nodeId, patch, scenario, host.catalog);
          if (validated.error) return { error: validated.error };
          const result = host.setParams(nodeId, validated.patch);
          return { data: result };
        });
      },
      start(options) {
        return request(++seq, () => {
          const validated = validateStartOptions(options);
          if (validated.error) return { error: validated.error };
          host.start(validated.options.speed);
          return { data: controlState(host) };
        });
      },
      pause() {
        return request(++seq, () => {
          host.pause();
          return { data: controlState(host) };
        });
      },
      reset() {
        return request(++seq, () => {
          host.reset();
          return { data: controlState(host) };
        });
      },
      getState() {
        return request(++seq, () => {
          const scenario = host.getScenario();
          const simulation = host.getSimulation();
          if (!isObject(scenario) || !Array.isArray(scenario.nodes) || !isObject(simulation) || !isObject(simulation.nodes)) {
            return { error: { code: ERROR_CODES.INVALID_STATE, message: 'Current simulation state is invalid' } };
          }
          return { data: buildSnapshot(simulation, scenario, host) };
        });
      },
      exportScenario() {
        return request(++seq, () => {
          const scenario = host.getScenario();
          const validated = validateScenario(scenario, host);
          if (validated.error) return { error: validated.error };
          return { data: clone(validated.scenario) };
        });
      }
    };
  }

  return { VERSION, ERROR_CODES, success, failure, validateScenario, validateParamPatch,
    validateStartOptions, buildSnapshot, createAgentApi };
});
