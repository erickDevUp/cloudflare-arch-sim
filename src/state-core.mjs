(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SIM_STATE_CORE = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /**
   * @typedef {Object} StateIdentity
   * @property {number | null} [scenarioRevision]
   * @property {string | null} [scenarioHash]
   * @property {string | null} [runId]
   * @property {boolean} [dirty]
   * @property {boolean} [saving]
   * @property {{ code: string, message: string, details?: unknown } | null} [saveError]
   */

  /**
   * @typedef {Object} RuntimeState
   * @property {number} time
   * @property {number} spent
   * @property {number} rate
   * @property {number} pathLat
   * @property {boolean} running
   * @property {number} speed
   * @property {string} plan
   * @property {number} baseFee
   * @property {number} budget
   * @property {number} requests
   * @property {number} [requestCount]
   * @property {number} modelSpent
   * @property {number} cpuRate
   * @property {Record<string, number>} backlog
   * @property {Record<string, number>} drops
   * @property {Record<string, Record<string, number | boolean>>} res
   * @property {Record<string, number>} chaos
   * @property {Record<string, unknown>} usage
   * @property {Record<string, unknown>} monthly
   * @property {Record<string, unknown>} modelSpend
   */

  /**
   * @typedef {Object} ScenarioNode
   * @property {string} id
   * @property {string} type
   */

  /**
   * @param {StateIdentity} identity
   * @returns {StateIdentity}
   */
  function identityState(identity) {
    return {
      scenarioRevision: identity.scenarioRevision == null ? null : identity.scenarioRevision,
      scenarioHash: identity.scenarioHash || null,
      runId: identity.runId == null ? null : identity.runId,
      dirty: !!identity.dirty,
      saving: !!identity.saving,
      saveError: identity.saveError || null
    };
  }

  /**
   * @param {StateIdentity} state
   * @param {Partial<StateIdentity>} identity
   */
  function restoreIdentity(state, identity) {
    const restored = identityState(Object.assign({}, state, identity));
    state.scenarioRevision = restored.scenarioRevision;
    state.scenarioHash = restored.scenarioHash;
    state.runId = restored.runId;
    state.dirty = restored.dirty;
    state.saving = restored.saving;
    state.saveError = restored.saveError;
  }

  /**
   * @param {StateIdentity} state
   */
  function markDirty(state) {
    state.dirty = true;
    state.scenarioRevision = null;
    state.scenarioHash = null;
    state.saveError = null;
  }

  /**
   * @param {StateIdentity} state
   * @param {boolean} saving
   */
  function setSaving(state, saving) {
    state.saving = !!saving;
  }

  /**
   * @param {StateIdentity} state
   * @param {{ code: string, message: string, details?: unknown }} error
   */
  function saveFailure(state, error) {
    state.dirty = true;
    state.saveError = error;
    return { error };
  }

  /**
   * @param {StateIdentity} state
   * @param {{ revision?: unknown, hash?: unknown, etag?: unknown } | null} storage
   */
  function markSaved(state, storage) {
    const parsed = parseStoredIdentity(storage);
    state.scenarioRevision = parsed.revision;
    state.scenarioHash = parsed.hash;
    state.dirty = false;
    state.saveError = null;
    return parsed;
  }

  /**
   * @param {{ revision?: unknown, hash?: unknown, etag?: unknown } | null} storage
   */
  function parseStoredIdentity(storage) {
    const revision = storage && Number(storage.revision);
    const hash = storage && typeof storage.hash === 'string' ? storage.hash : null;
    return {
      revision: Number.isInteger(revision) ? revision : null,
      hash,
      etag: storage && storage.etag || (hash ? '"' + hash + '"' : null)
    };
  }

  /**
   * @param {unknown} left
   * @param {unknown} right
   */
  function sameScenario(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  /**
   * @param {boolean} pendingSave
   * @param {boolean} dirty
   * @param {boolean} booted
   * @returns {'apply' | 'identity'}
   */
  function bootstrapAction(pendingSave, dirty, booted) {
    if (pendingSave || dirty || booted) return 'identity';
    return 'apply';
  }

  /**
   * @param {RuntimeState} runtime
   * @param {ScenarioNode[]} nodes
   * @param {StateIdentity} identity
   */
  function simulationSnapshot(runtime, nodes, identity) {
    const metrics = Object.create(null);
    nodes.forEach(node => {
      const result = runtime.res[node.id] || {};
      metrics[node.id] = {
        type: node.type,
        lambda: result.lambda || 0,
        util: result.util || 0,
        err: result.err || 0,
        lat: result.lat || 0,
        cost: result.cost || 0,
        out: result.out || 0,
        capacity: result.capacity || 0,
        backlog: runtime.backlog[node.id] || 0,
        drops: runtime.drops[node.id] || 0,
        billedRequests: result.billedRequests || 0,
        doGbS: result.doGbS || 0,
        objects: result.objects || 0,
        perObjectRate: result.perObjectRate || 0,
        objectLimit: result.objectLimit || 0,
        overloaded: !!result.overloaded
      };
    });
    return {
      time: runtime.time,
      spent: runtime.spent,
      rate: runtime.rate,
      pathLat: runtime.pathLat,
      running: runtime.running,
      speed: runtime.speed,
      plan: runtime.plan,
      baseFee: runtime.baseFee,
      budget: runtime.budget,
      requests: runtime.requests,
      requestCount: runtime.requestCount == null ? runtime.requests : runtime.requestCount,
      modelSpent: runtime.modelSpent,
      cpuRate: runtime.cpuRate,
      ...identityState(identity),
      chaos: Object.keys(runtime.chaos).filter(key => runtime.chaos[key] > runtime.time),
      usage: runtime.usage,
      monthly: runtime.monthly,
      modelSpend: runtime.modelSpend,
      nodes: metrics
    };
  }

  /**
   * @param {Pick<RuntimeState, 'running' | 'speed' | 'time'>} simulation
   * @param {StateIdentity} identity
   */
  function controlState(simulation, identity) {
    const stored = identityState(identity);
    return {
      running: simulation.running,
      speed: simulation.speed,
      time: simulation.time,
      runId: stored.runId,
      scenarioRevision: stored.scenarioRevision,
      scenarioHash: stored.scenarioHash,
      dirty: stored.dirty,
      saving: stored.saving,
      saveError: stored.saveError
    };
  }

  return {
    identityState, restoreIdentity, markDirty, setSaving, saveFailure, markSaved, parseStoredIdentity,
    sameScenario, bootstrapAction, simulationSnapshot, controlState
  };
});
