(function (root, factory) {
  const core = typeof module === 'object' && module.exports ? require('./state-core.cjs') : root && root.SIM_STATE_CORE;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SIM_API_FACTORY = api;
})(typeof window !== 'undefined' ? window : null, function (CORE) {
  'use strict';

  if (!CORE) throw new Error('SIM_API state core is missing');

  const VERSION = 1;
  const SCHEMA_VERSION = 1;
  const MODEL_VERSION = 'rate-v1';
  const LIMITS = Object.freeze({
    maxSpeed: 7200,
    maxRunSeconds: 31536000,
    maxScenarioBytes: 1048576,
    maxHashChars: 8000
  });
  const PLANS = Object.freeze(['free', 'paid', 'custom']);
  const BILLING_LIMITS = Object.freeze({ baseFee: 0, budget: 1 });
  const ERROR_CODES = Object.freeze({
    INVALID_SCENARIO: 'INVALID_SCENARIO',
    UNSUPPORTED_SCHEMA_VERSION: 'UNSUPPORTED_SCHEMA_VERSION',
    UNSUPPORTED_NODE_TYPE: 'UNSUPPORTED_NODE_TYPE',
    UNSUPPORTED_PARAMETER: 'UNSUPPORTED_PARAMETER',
    PARAMETER_OUT_OF_RANGE: 'PARAMETER_OUT_OF_RANGE',
    UNKNOWN_NODE: 'UNKNOWN_NODE',
    INVALID_PARAMS: 'INVALID_PARAMS',
    INVALID_OPTIONS: 'INVALID_OPTIONS',
    INVALID_STATE: 'INVALID_STATE',
    SAVE_FAILED: 'SAVE_FAILED',
    CHANNEL_UNAVAILABLE: 'CHANNEL_UNAVAILABLE',
    STORAGE_CONFLICT: 'STORAGE_CONFLICT',
    INTERNAL_ERROR: 'INTERNAL_ERROR'
  });
  const LIMITATIONS = Object.freeze([
    'Rate model only; not a load test or Cloudflare emulator.',
    'Retries, variable batches, distributed coordination, storage/egress, and real provider capacity are not modeled.',
    'Cycles and their dependent nodes receive zero traffic in the topological pass.',
    'Durable Object arrivals are evenly sharded and active duration is capped per object.',
    'Chaos events are limited to the predefined catalog scenarios.',
    'HTTP v1 and CLI JSON interfaces are not provided.'
  ]);
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

  function finish(requestId, result) {
    if (result && result.error) return failure(requestId, result.error.code, result.error.message, result.error.details);
    return success(requestId, result.data);
  }

  function internalFailure(requestId, err) {
    return failure(requestId, ERROR_CODES.INTERNAL_ERROR, 'SIM_API request failed', {
      message: String((err && err.message) || err).split('\n')[0]
    });
  }

  function request(seq, run) {
    const requestId = 'sim-v1-' + String(seq).padStart(6, '0');
    try {
      const result = run();
      if (result && typeof result.then === 'function') {
        return result.then(value => finish(requestId, value), err => internalFailure(requestId, err));
      }
      return finish(requestId, result);
    } catch (err) {
      return internalFailure(requestId, err);
    }
  }

  function effectiveType(node) {
    if (node && node.type === 'workers_ai' && isObject(node.p) &&
        (hasOwn(node.p, 'inPrice') || hasOwn(node.p, 'outPrice'))) return 'external_model';
    return node && node.type;
  }

  function inspectParams(raw, catalog) {
    const unsupported = [];
    const invalid = [];
    const outOfRange = [];
    (raw.nodes || []).forEach((node, index) => {
      if (!isObject(node) || !isObject(node.p)) return;
      const type = effectiveType(node);
      const def = hasOwn(catalog.types, type) ? catalog.types[type] : null;
      if (!def) return;
      const nodeId = typeof node.id === 'string' && node.id ? node.id : 'nodes[' + index + ']';
      Object.keys(node.p).forEach(param => {
        const value = node.p[param];
        if (!hasOwn(def.p || {}, param)) {
          unsupported.push({ nodeId, param });
          return;
        }
        if (value === null && def.p[param] === null) return;
        if (catalog.enums[param]) {
          if (!catalog.enums[param].includes(value)) invalid.push({ nodeId, param, reason: 'not an allowed value' });
          return;
        }
        if (!finite(value)) {
          invalid.push({ nodeId, param, reason: 'expected a finite number' });
          return;
        }
        const range = catalog.ranges[param];
        if (range && (value < range[0] || value > range[1])) {
          outOfRange.push({ nodeId, param, min: range[0], max: range[1] });
        }
      });
    });
    return { unsupported, invalid, outOfRange };
  }

  function validateScenario(raw, host, options) {
    const strict = !options || options.strict !== false;
    if (!isObject(raw)) {
      return { error: { code: ERROR_CODES.INVALID_SCENARIO, message: 'Scenario must be an object' } };
    }
    let bytes;
    try {
      bytes = new TextEncoder().encode(JSON.stringify(raw)).length;
    } catch (err) {
      return { error: { code: ERROR_CODES.INVALID_SCENARIO, message: 'Scenario must be JSON-serializable' } };
    }
    if (bytes > LIMITS.maxScenarioBytes) {
      return {
        error: {
          code: ERROR_CODES.INVALID_SCENARIO,
          message: 'Scenario exceeds the size limit',
          details: { maxBytes: LIMITS.maxScenarioBytes, receivedBytes: bytes }
        }
      };
    }
    const warnings = [];
    if (raw.version !== undefined && raw.version !== SCHEMA_VERSION) {
      if (strict) {
        return {
          error: {
            code: ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
            message: 'Unsupported scenario schema version',
            details: { expected: SCHEMA_VERSION, received: raw.version }
          }
        };
      }
      warnings.push('Unsupported schema version normalized to ' + SCHEMA_VERSION);
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
    const params = inspectParams(raw, host.catalog);
    if (params.unsupported.length && strict) {
      return {
        error: {
          code: ERROR_CODES.UNSUPPORTED_PARAMETER,
          message: 'Scenario contains unsupported node params',
          details: { params: params.unsupported }
        }
      };
    }
    if (params.invalid.length) {
      return {
        error: {
          code: ERROR_CODES.INVALID_PARAMS,
          message: 'Scenario contains invalid node params',
          details: { params: params.invalid }
        }
      };
    }
    if (params.outOfRange.length) {
      return {
        error: {
          code: ERROR_CODES.PARAMETER_OUT_OF_RANGE,
          message: 'Scenario contains out-of-range node params',
          details: { params: params.outOfRange }
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
    const scenario = clone(validated.scenario);
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
    const unsupportedNodes = scenario.nodes.filter(node => !hasOwn(host.catalog.types, node.type));
    if (unsupportedNodes.length && strict) {
      return {
        error: {
          code: ERROR_CODES.UNSUPPORTED_NODE_TYPE,
          message: 'Scenario contains unsupported node types',
          details: { nodes: unsupportedNodes.map(node => ({ id: node.id || null, type: node.type })) }
        }
      };
    }
    if (validated.error) warnings.push(validated.error);
    const unsupported = [
      ...unsupportedNodes.map(node => ({ kind: 'node_type', nodeId: node.id || null, type: node.type })),
      ...params.unsupported.map(item => Object.assign({ kind: 'parameter' }, item))
    ];
    if (unsupported.length) warnings.push('Unsupported content preserved in non-strict mode');
    return { scenario, warnings, unsupported };
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
    const outOfRange = [];
    const unsupported = [];
    const safe = {};
    Object.keys(patch).forEach(key => {
      const value = patch[key];
      if (!hasOwn(allowed, key)) {
        unsupported.push(key);
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
        outOfRange.push({ param: key, min: range[0], max: range[1] });
        return;
      }
      safe[key] = value;
    });
    if (unsupported.length) {
      return {
        error: {
          code: ERROR_CODES.UNSUPPORTED_PARAMETER,
          message: 'Unsupported node params',
          details: { nodeId, params: unsupported }
        }
      };
    }
    if (invalid.length) {
      return {
        error: {
          code: ERROR_CODES.INVALID_PARAMS,
          message: 'Invalid node params',
          details: { nodeId, params: invalid }
        }
      };
    }
    if (outOfRange.length) {
      return {
        error: {
          code: ERROR_CODES.PARAMETER_OUT_OF_RANGE,
          message: 'Node params are outside catalog ranges',
          details: { nodeId, params: outOfRange }
        }
      };
    }
    return { patch: safe };
  }

  function validateBooleanOptions(options, allowed) {
    if (options === undefined) return { options: {} };
    if (!isObject(options)) {
      return { error: { code: ERROR_CODES.INVALID_OPTIONS, message: 'Options must be an object' } };
    }
    const unknown = Object.keys(options).filter(key => !allowed.includes(key));
    if (unknown.length) {
      return {
        error: {
          code: ERROR_CODES.INVALID_OPTIONS,
          message: 'Unsupported options',
          details: { options: unknown }
        }
      };
    }
    const invalid = allowed.filter(key => options[key] !== undefined && typeof options[key] !== 'boolean');
    if (invalid.length) {
      return {
        error: {
          code: ERROR_CODES.INVALID_OPTIONS,
          message: 'Boolean options required',
          details: { options: invalid }
        }
      };
    }
    return { options: Object.fromEntries(allowed.map(key => [key, options[key]])) };
  }

  function validateSpeed(speed) {
    if (!Number.isInteger(speed) || speed < 1 || speed > LIMITS.maxSpeed) {
      return {
        error: {
          code: ERROR_CODES.INVALID_PARAMS,
          message: 'Speed must be an integer from 1 through ' + LIMITS.maxSpeed,
          details: { speed }
        }
      };
    }
    return { speed };
  }

  function validatePlan(plan) {
    if (!PLANS.includes(plan)) {
      return {
        error: {
          code: ERROR_CODES.INVALID_PARAMS,
          message: 'Plan must be free, paid, or custom',
          details: { plan, allowedPlans: PLANS.slice() }
        }
      };
    }
    return { plan };
  }

  function validateBillingPatch(patch) {
    if (!isObject(patch) || !Object.keys(patch).length) {
      return { error: { code: ERROR_CODES.INVALID_PARAMS, message: 'Billing inputs patch must be a non-empty object' } };
    }
    const unsupported = Object.keys(patch).filter(key => !hasOwn(BILLING_LIMITS, key));
    if (unsupported.length) {
      return {
        error: {
          code: ERROR_CODES.UNSUPPORTED_PARAMETER,
          message: 'Unsupported billing inputs',
          details: { params: unsupported }
        }
      };
    }
    const invalid = [];
    const outOfRange = [];
    const safe = {};
    Object.keys(patch).forEach(key => {
      const value = patch[key];
      if (!finite(value)) {
        invalid.push({ param: key, reason: 'expected a finite number' });
      } else if (value < BILLING_LIMITS[key]) {
        outOfRange.push({ param: key, min: BILLING_LIMITS[key] });
      } else {
        safe[key] = value;
      }
    });
    if (invalid.length) {
      return {
        error: {
          code: ERROR_CODES.INVALID_PARAMS,
          message: 'Invalid billing inputs',
          details: { params: invalid }
        }
      };
    }
    if (outOfRange.length) {
      return {
        error: {
          code: ERROR_CODES.PARAMETER_OUT_OF_RANGE,
          message: 'Billing inputs are below their minimum values',
          details: { params: outOfRange }
        }
      };
    }
    return { patch: safe };
  }

  function validateRunOptions(options) {
    if (!isObject(options) || Object.keys(options).some(key => key !== 'seconds')) {
      return { error: { code: ERROR_CODES.INVALID_OPTIONS, message: 'Run requires a seconds option' } };
    }
    if (!finite(options.seconds) || options.seconds <= 0 || options.seconds > LIMITS.maxRunSeconds) {
      return {
        error: {
          code: ERROR_CODES.INVALID_OPTIONS,
          message: 'Seconds must be finite and greater than zero',
          details: { min: 0, max: LIMITS.maxRunSeconds, seconds: options.seconds }
        }
      };
    }
    return { seconds: options.seconds };
  }

  function cycleNodes(scenario) {
    const nodes = new Map(scenario.nodes.map(node => [node.id, node]));
    const indegree = new Map(scenario.nodes.map(node => [node.id, 0]));
    const outgoing = new Map(scenario.nodes.map(node => [node.id, []]));
    (scenario.edges || []).forEach(edge => {
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) return;
      if (edge.weight !== undefined && edge.weight <= 0) return;
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

  function unsupportedContent(scenario, catalog) {
    const unsupported = [];
    scenario.nodes.forEach(node => {
      const def = hasOwn(catalog.types, node.type) ? catalog.types[node.type] : null;
      if (!def) {
        unsupported.push({ kind: 'node_type', nodeId: node.id || null, type: node.type });
        return;
      }
      Object.keys(node.p || {}).forEach(param => {
        if (!hasOwn(def.p || {}, param)) unsupported.push({ kind: 'parameter', nodeId: node.id, param });
      });
    });
    return unsupported;
  }

  function stateWarnings(scenario, simulation, catalog) {
    const warnings = [];
    const unsupported = unsupportedContent(scenario, catalog);
    if (unsupported.length) {
      warnings.push({
        code: 'UNSUPPORTED_CONTENT',
        message: 'Unsupported content is excluded from simulation',
        details: { unsupported }
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

  function nodeMetrics(node) {
    const metrics = {
      type: node.type,
      lambda: node.lambda || 0,
      out: node.out || 0,
      util: node.util || 0,
      err: node.err || 0,
      lat: node.lat || 0,
      cost: node.cost || 0,
      units: {
        lambda: 'requests/s', out: 'requests/s', util: 'fraction', err: 'fraction',
        lat: 'seconds', cost: 'USD/s'
      }
    };
    if (node.type === 'queues') {
      metrics.capacity = node.capacity || 0;
      metrics.backlog = node.backlog || 0;
      metrics.drops = node.drops || 0;
      metrics.units.capacity = 'requests/s';
      metrics.units.backlog = 'messages';
      metrics.units.drops = 'messages/s';
    }
    if (node.type === 'durable_objects') {
      metrics.billedRequests = node.billedRequests || 0;
      metrics.doGbS = node.doGbS || 0;
      metrics.objects = node.objects || 0;
      metrics.perObjectRate = node.perObjectRate || 0;
      metrics.objectLimit = node.objectLimit || 0;
      metrics.overloaded = !!node.overloaded;
      metrics.units.billedRequests = 'requests/s';
      metrics.units.doGbS = 'GB-s/month';
      metrics.units.objects = 'count';
      metrics.units.perObjectRate = 'requests/s';
      metrics.units.objectLimit = 'requests/s';
    }
    return metrics;
  }

  function buildSnapshot(simulation, scenario, host) {
    const catalog = host.catalog;
    const pricing = host.pricing;
    const model = host.getModel();
    const identity = CORE.identityState(host.getIdentity());
    const provenanceNodes = Object.fromEntries(scenario.nodes.map(node => {
      const def = hasOwn(catalog.types, node.type) ? catalog.types[node.type] : {};
      return [node.id, {
        type: node.type,
        verified: !!def.verified,
        verifiedNote: def.verified || null,
        classification: def.verified ? 'verified_platform_fact' : 'unverified_model_assumption',
        source: def.doc || null,
        note: def.note || null,
        params: Object.fromEntries(Object.entries(node.p || {}).map(([key, value]) => [
          key, { value, classification: 'editable_model_assumption' }
        ]))
      }];
    }));
    const assumptions = [
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
      },
      ...scenario.nodes.flatMap(node => Object.keys(node.p || {}).map(param => ({
        id: 'node.' + node.id + '.' + param,
        value: node.p[param],
        classification: 'editable_model_assumption'
      })))
    ];
    const plan = simulation.plan;
    const daysPerMonth = pricing.hoursPerMonth / 24;
    const units = Object.fromEntries(pricing.dims.map(dim => [dim.id, {
      unit: plan === 'free' && dim.freePerRequest != null
        ? dim.usageUnit.replace('/month', '/request')
        : plan === 'free' && dim.freeDaily != null
          ? dim.usageUnit.replace('/month', '/day')
          : dim.usageUnit,
      billingUnit: dim.unit,
      period: plan === 'free'
        ? dim.freePerRequest != null ? 'per request' : dim.freeDaily != null ? 'per day' : 'per month'
        : 'per month',
      price: dim.price,
      currency: 'USD',
      verified: dim.verified,
      source: dim.source
    }]));
    const nodes = Object.fromEntries(Object.entries(simulation.nodes || {}).map(([id, node]) => [id, nodeMetrics(node)]));
    const warnings = stateWarnings(scenario, simulation, catalog);
    const modelSpend = simulation.modelSpend || { set: false, total: 0 };
    const requestCount = simulation.requestCount == null ? simulation.requests || 0 : simulation.requestCount;
    const modelAssessment = {
      set: !!modelSpend.set,
      monthly: modelSpend.total || 0,
      accumulated: simulation.modelSpent || 0,
      perRequest: modelSpend.set && requestCount > 0 ? (simulation.modelSpent || 0) / requestCount : null,
      priceInputs: scenario.nodes.filter(node => node.type === 'external_model').map(node => ({
        nodeId: node.id,
        inPrice: node.p.inPrice,
        outPrice: node.p.outPrice,
        inTokens: node.p.inTokens,
        outTokens: node.p.outTokens
      })),
      units: { monthly: 'USD/month', accumulated: 'USD', perRequest: 'USD/request' }
    };
    const monthly = simulation.monthly || {};
    const usage = simulation.usage || {};
    const allowances = pricing.dims.map(dim => {
      const line = (monthly.lines || []).find(item => item.id === dim.id);
      const monthlyUsed = line ? line.used : usage[dim.id] || 0;
      let used = monthlyUsed;
      let included = null;
      let over = null;
      let billable = null;
      let cost = null;
      let allowanceStatus = 'included';
      let reason;
      if (plan === 'free') {
        included = dim.freePerRequest != null
          ? dim.freePerRequest
          : dim.freeDaily != null ? dim.freeDaily : dim.freeMonthly;
        used = dim.freePerRequest != null
          ? line ? line.used : usage.cpuMsPerRequest || 0
          : dim.freeDaily != null ? monthlyUsed / daysPerMonth : monthlyUsed;
        over = dim.freeDaily != null ? used > included : line ? line.over : used > included;
        billable = 0;
        cost = 0;
      } else if (plan === 'paid') {
        included = dim.paidIncluded;
        over = line ? line.over : monthlyUsed > included;
        billable = line ? line.billable || 0 : 0;
        cost = line ? line.cost || 0 : 0;
      } else {
        allowanceStatus = 'not_applicable';
        reason = 'Custom plan has no included allowances; per-dimension billable and cost are not allocated because monthly.total uses the aggregate live rate.';
      }
      const allowance = {
        id: dim.id,
        label: dim.label,
        unit: units[dim.id].unit,
        period: units[dim.id].period,
        used,
        included,
        over,
        exceeded: over == null ? null : over > 0,
        billable,
        cost,
        allowanceStatus,
        verified: dim.verified
      };
      if (reason) allowance.reason = reason;
      return allowance;
    });
    const exceeded = allowances.filter(item => item.exceeded === true);
    const cloudflare = {
      rate: simulation.rate || 0,
      spent: simulation.spent || 0,
      usage: simulation.usage || {},
      monthly,
      allowances,
      overage: monthly.overage || 0,
      exceeded,
      unverified: monthly.unverified || [],
      units
    };
    const diagnostics = {
      warnings,
      unsupported: unsupportedContent(scenario, catalog),
      assumptions,
      limitations: LIMITATIONS.slice()
    };
    const provenance = {
      asOf: pricing.asOf,
      hoursPerMonth: pricing.hoursPerMonth,
      sources: pricing.sources,
      dimensions: pricing.dims,
      pricing: {
        asOf: pricing.asOf,
        hoursPerMonth: pricing.hoursPerMonth,
        sources: pricing.sources,
        dimensions: pricing.dims
      },
      nodes: provenanceNodes
    };
    return clone({
      apiVersion: VERSION,
      schemaVersion: SCHEMA_VERSION,
      modelVersion: MODEL_VERSION,
      ...identity,
      version: VERSION,
      scenario,
      time: simulation.time,
      running: simulation.running,
      speed: simulation.speed,
      plan: simulation.plan,
      budget: simulation.budget,
      baseFee: simulation.baseFee,
      requestCount,
      units: {
        time: 'simulated seconds', spent: 'USD', rate: 'USD/s', pathLat: 'seconds',
        requestCount: 'requests', budget: 'USD/month', baseFee: 'USD/month', speed: 'simulated seconds/real second'
      },
      simulation: {
        time: simulation.time,
        running: simulation.running,
        speed: simulation.speed,
        spent: simulation.spent,
        rate: simulation.rate,
        pathLat: simulation.pathLat,
        requestCount,
        requests: simulation.requests == null ? requestCount : simulation.requests,
        modelSpent: simulation.modelSpent,
        cpuRate: simulation.cpuRate,
        baseFee: simulation.baseFee,
        budget: simulation.budget,
        chaos: simulation.chaos
      },
      cloudflare,
      model: modelAssessment,
      nodes,
      diagnostics,
      unsupported: diagnostics.unsupported,
      limitations: diagnostics.limitations,
      provenance,
      usage: cloudflare.usage,
      monthly: cloudflare.monthly,
      modelSpend: { set: modelAssessment.set, total: modelAssessment.monthly },
      warnings,
      assumptions
    });
  }

  function stateResult(host) {
    const scenario = host.getScenario();
    const simulation = host.getSimulation();
    if (!isObject(scenario) || !Array.isArray(scenario.nodes) || !isObject(simulation) || !isObject(simulation.nodes)) {
      return { error: { code: ERROR_CODES.INVALID_STATE, message: 'Current simulation state is invalid' } };
    }
    return { data: buildSnapshot(simulation, scenario, host) };
  }

  function capabilities(host) {
    return clone({
      apiVersion: VERSION,
      schemaVersion: SCHEMA_VERSION,
      modelVersion: MODEL_VERSION,
      deterministicClock: true,
      clock: 'simulated-seconds',
      supportedNodeTypes: Object.keys(host.catalog.types).sort(),
      limits: LIMITS,
      persistence: host.getChannelStatus(),
      methods: ['capabilities', 'validate', 'loadScenario', 'setParams', 'setPlan', 'setBillingInputs',
        'start', 'pause', 'reset', 'run', 'setSpeed', 'getState', 'exportScenario', 'save',
        'load', 'set', 'state', 'export']
    });
  }

  function createAgentApi(host) {
    if (!host || !host.scenario || !host.catalog || !host.pricing || !host.getScenario ||
        !host.getSimulation || !host.getIdentity || !host.getModel || !host.loadScenario ||
        !host.setParams || !host.setPlan || !host.setBillingInputs || !host.start || !host.pause || !host.reset || !host.run ||
        !host.setSpeed || !host.saveScenario || !host.getChannelStatus) {
      throw new Error('SIM_API host is incomplete');
    }
    let seq = 0;
    const loadedData = (validated, saved) => {
      const identity = CORE.identityState(host.getIdentity());
      return {
        scenario: host.getScenario(),
        warnings: validated.warnings,
        unsupported: validated.unsupported,
        scenarioRevision: identity.scenarioRevision,
        scenarioHash: identity.scenarioHash,
        runId: identity.runId,
        dirty: identity.dirty,
        save: saved
      };
    };
    const api = {
      version: VERSION,
      apiVersion: VERSION,
      capabilities() {
        return request(++seq, () => ({ data: capabilities(host) }));
      },
      validate(raw) {
        return request(++seq, () => {
          const validated = validateScenario(raw, host, { strict: true });
          if (validated.error) return { error: validated.error };
          return { data: { valid: true, scenario: validated.scenario, warnings: validated.warnings, unsupported: validated.unsupported } };
        });
      },
      loadScenario(raw, options) {
        return request(++seq, () => {
          const checked = validateBooleanOptions(options, ['resetRuntime', 'persist', 'strict']);
          if (checked.error) return { error: checked.error };
          const resetRuntime = checked.options.resetRuntime !== false;
          const persist = checked.options.persist === true;
          const strict = checked.options.strict !== false;
          const validated = validateScenario(raw, host, { strict });
          if (validated.error) return { error: validated.error };
          const install = saved => {
            if (saved && saved.scenario) validated.scenario = saved.scenario;
            host.loadScenario(validated.scenario, { resetRuntime, persisted: persist });
            return { data: loadedData(validated, saved) };
          };
          if (!persist) return install(null);
          return Promise.resolve(host.saveScenario(validated.scenario)).then(result => {
            if (result.error) return { error: result.error };
            return install(result.data);
          });
        });
      },
      setParams(nodeId, params) {
        return request(++seq, () => {
          const scenario = host.getScenario();
          if (!isObject(scenario) || !Array.isArray(scenario.nodes)) {
            return { error: { code: ERROR_CODES.INVALID_STATE, message: 'Current scenario is invalid' } };
          }
          const validated = validateParamPatch(nodeId, params, scenario, host.catalog);
          if (validated.error) return { error: validated.error };
          return { data: host.setParams(nodeId, validated.patch) };
        });
      },
      setPlan(plan) {
        return request(++seq, () => {
          const validated = validatePlan(plan);
          if (validated.error) return { error: validated.error };
          host.setPlan(validated.plan);
          return stateResult(host);
        });
      },
      setBillingInputs(patch) {
        return request(++seq, () => {
          const validated = validateBillingPatch(patch);
          if (validated.error) return { error: validated.error };
          host.setBillingInputs(validated.patch);
          return stateResult(host);
        });
      },
      reset() {
        return request(++seq, () => {
          host.reset();
          return { data: CORE.controlState(host.getSimulation(), host.getIdentity()) };
        });
      },
      run(options) {
        return request(++seq, () => {
          const validated = validateRunOptions(options);
          if (validated.error) return { error: validated.error };
          host.run(validated.seconds);
          return { data: CORE.controlState(host.getSimulation(), host.getIdentity()) };
        });
      },
      pause() {
        return request(++seq, () => {
          host.pause();
          return { data: CORE.controlState(host.getSimulation(), host.getIdentity()) };
        });
      },
      setSpeed(speed) {
        return request(++seq, () => {
          const validated = validateSpeed(speed);
          if (validated.error) return { error: validated.error };
          host.setSpeed(validated.speed);
          return { data: CORE.controlState(host.getSimulation(), host.getIdentity()) };
        });
      },
      start(options) {
        return request(++seq, () => {
          if (options !== undefined && (!isObject(options) || Object.keys(options).some(key => key !== 'speed'))) {
            return { error: { code: ERROR_CODES.INVALID_OPTIONS, message: 'Start only accepts an optional speed' } };
          }
          const speed = options && options.speed;
          if (speed !== undefined) {
            const validated = validateSpeed(speed);
            if (validated.error) return { error: validated.error };
          }
          host.start(speed);
          return { data: CORE.controlState(host.getSimulation(), host.getIdentity()) };
        });
      },
      getState() {
        return request(++seq, () => stateResult(host));
      },
      exportScenario(options) {
        return request(++seq, () => {
          const checked = validateBooleanOptions(options, ['assessment', 'provenance']);
          if (checked.error) return { error: checked.error };
          const scenario = host.getScenario();
          const validated = validateScenario(scenario, host, { strict: true });
          if (validated.error) return { error: validated.error };
          if (!checked.options.assessment && !checked.options.provenance) return { data: clone(validated.scenario) };
          const snapshot = buildSnapshot(host.getSimulation(), validated.scenario, host);
          const data = { scenario: snapshot.scenario };
          if (checked.options.assessment) {
            data.assessment = {
              cloudflare: snapshot.cloudflare,
              model: snapshot.model,
              nodes: snapshot.nodes,
              diagnostics: snapshot.diagnostics
            };
          }
          if (checked.options.provenance) data.provenance = snapshot.provenance;
          return { data };
        });
      },
      _fail(code, message, details) {
        return request(++seq, () => ({ error: { code, message, details } }));
      },
      save() {
        return request(++seq, () => {
          const scenario = host.getScenario();
          const validated = validateScenario(scenario, host, { strict: true });
          if (validated.error) return { error: validated.error };
          return Promise.resolve(host.saveScenario(validated.scenario)).then(result => {
            if (result.error) return { error: result.error };
            return { data: result.data };
          });
        });
      }
    };
    api.load = (raw, options) => api.loadScenario(raw, options);
    api.set = (nodeId, params) => api.setParams(nodeId, params);
    api.state = () => api.getState();
    api.export = options => api.exportScenario(options);
    return api;
  }

  return {
    VERSION, SCHEMA_VERSION, MODEL_VERSION, LIMITS, ERROR_CODES,
    success, failure, validateScenario, validateParamPatch, validatePlan, validateBillingPatch, validateRunOptions,
    buildSnapshot, createAgentApi
  };
});
