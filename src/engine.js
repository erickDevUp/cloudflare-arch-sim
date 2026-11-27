(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QUEUE_ENGINE = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const DEFAULT_RETENTION = 345600;
  const MODEL = Object.freeze({
    erlangServerCap: 400,
    saturatedWaitS: 30,
    queueOpsPerMessage: 3,
    queueMaxThroughput: 5000,
    doRequestsPerSecondPerObject: 1000,
    doWebSocketMessageRatio: 20,
    doMemoryGb: 0.128
  });

  function capacity(p) {
    if (!(p.concurrency > 0) || !(p.latency > 0)) return 0;
    return Math.min(MODEL.queueMaxThroughput, p.concurrency / (p.latency / 1000));
  }

  function forward(lambda, p, isQueue) {
    if (!isQueue) return lambda;
    const cap = capacity(p);
    return cap > 0 ? Math.min(lambda, cap) : 0;
  }

  function queueWait(backlog, cap, p, lambda) {
    if (cap > 0) return Math.max(0, backlog) / cap;
    if (!(lambda > 0)) return 0;
    const retention = p.retention == null ? DEFAULT_RETENTION : p.retention;
    return retention > 0 ? retention : MODEL.saturatedWaitS;
  }

  function step(backlog, lambda, cap, dt, retention) {
    const t = retention == null ? DEFAULT_RETENTION : retention;
    const current = Math.max(0, backlog);
    if (!(dt > 0)) return { backlog: current, drops: 0 };
    if (!(cap > 0)) {
      if (!(lambda > 0)) return { backlog: 0, drops: current / dt };
      if (t > 0) return { backlog: lambda * t, drops: lambda };
      return { backlog: current + lambda * dt, drops: 0 };
    }
    const wait = current / cap;
    const nextWait = Math.max(0, wait + (lambda / cap - 1) * dt);
    const keptWait = t > 0 ? Math.min(nextWait, t) : nextWait;
    const expiredMsgs = (nextWait - keptWait) * cap;
    return { backlog: keptWait * cap, drops: expiredMsgs / dt };
  }

  function advanceClock(runtime, seconds, step, settle) {
    let remaining = seconds;
    while (remaining > 0) {
      const deadlines = Object.values(runtime.chaos || {})
        .filter(value => typeof value === 'number' && isFinite(value) && value > runtime.time);
      const until = deadlines.length ? Math.min.apply(null, deadlines) - runtime.time : Infinity;
      const dt = Math.min(remaining, until);
      const sample = step(dt, runtime.time) || {};
      runtime.time += dt;
      runtime.spent = (runtime.spent || 0) + (+sample.rate || 0) * dt;
      runtime.requests = (runtime.requests || 0) + (+sample.requests || 0) * dt;
      runtime.modelSpent = (runtime.modelSpent || 0) + (+sample.modelRate || 0) * dt;
      Object.keys(runtime.chaos || {}).forEach(key => {
        if (runtime.chaos[key] <= runtime.time) delete runtime.chaos[key];
      });
      remaining -= dt;
      if (settle) settle(runtime.time);
    }
    return runtime;
  }

  function erlangC(a, c) {
    const servers = Math.max(1, Math.round(c));
    if (servers <= 1) return Math.min(1, a);
    if (a <= 0) return 0;
    const rho = a / servers;
    if (rho >= 1) return 1;
    let sum = 1, term = 1;
    const cap = Math.min(servers, MODEL.erlangServerCap);
    for (let k = 1; k < cap; k++) { term *= a / k; sum += term; }
    const acfact = term * a / cap;
    const tail = acfact / (1 - rho);
    return tail / (sum + tail);
  }

  function durableObject(lambda, p, latencyS, hoursPerMonth) {
    const objects = Math.max(1, Math.round(p.objects || 1));
    const socket = p.transport === 'websocket' || p.transport === 'hibernatable';
    const billedRequests = socket
      ? (p.connections || 0) + lambda / MODEL.doWebSocketMessageRatio
      : lambda;
    const monthSeconds = hoursPerMonth * 3600;
    const activeWindow = objects * monthSeconds * Math.max(0, Math.min(100, p.activePct == null ? 100 : p.activePct)) / 100;
    let activeSeconds;
    if (p.activeSeconds > 0) activeSeconds = Math.min(activeWindow, p.activeSeconds);
    else if (p.transport === 'websocket') activeSeconds = activeWindow;
    else if (p.transport === 'hibernatable') {
      activeSeconds = Math.min(activeWindow, lambda * (p.activeMs || 0) / 1000 * monthSeconds);
    } else activeSeconds = Math.min(activeWindow, lambda * latencyS * monthSeconds);
    return {
      objects, socket, billedRequests,
      perObjectRate: lambda / objects,
      objectLimit: MODEL.doRequestsPerSecondPerObject,
      activeSeconds, gbS: activeSeconds * MODEL.doMemoryGb
    };
  }

  function model429(type, p, active) {
    if (!active || (type !== 'workers_ai' && type !== 'external_model')) return { p, slashed: false };
    const next = Object.assign({}, p);
    next.latency *= 3;
    next.concurrency = Math.max(1, Math.round(next.concurrency * 0.4));
    return { p: next, slashed: true };
  }

  function emptyResult() {
    return { lambda: 0, util: 0, err: 0, lat: 0, hit: 0, cpu: 0, cost: 0, out: 0,
      backlog: 0, drops: 0, billedRequests: 0, doGbS: 0, objects: 0,
      perObjectRate: 0, objectLimit: MODEL.doRequestsPerSecondPerObject, overloaded: false };
  }

  function nodeCost(n, r, p, def, hoursPerMonth) {
    if (def.cloudflare === false) return 0;
    const monthSeconds = hoursPerMonth * 3600;
    if (n.type === 'workers_ai') {
      const neurons = r.lambda * ((p.inTokens || 0) * (p.neuronsIn || 0) +
        (p.outTokens || 0) * (p.neuronsOut || 0)) / 1e6;
      return neurons * (def.priceNeurons || 0) / 1000;
    }
    if (n.type === 'images') {
      return ((p.uniqueTransforms || 0) / 1000 * (p.pricePerThousand || 0) +
        (p.imagesStored || 0) / 100000 * (p.priceStored || 0) +
        (p.imagesDelivered || 0) / 100000 * (p.priceDelivered || 0)) / monthSeconds;
    }
    if (n.type === 'stream') {
      return (Math.ceil((p.minutesStored || 0) / 1000) * 1000 / 1000 * (p.storagePrice || 0) +
        (p.minutesDelivered || 0) / 1000 * (p.deliveryPricePerThousand || 0)) / monthSeconds;
    }
    let cost = r.lambda * (p.units || 0) * (p.price || 0) / 1e6;
    if (n.type === 'workers') cost += r.lambda * (p.cpuMs || 0) * (def.priceCpu || 0) / 1e6;
    if (n.type === 'queues') cost = Math.max(0, cost * MODEL.queueOpsPerMessage - (r.drops || 0) * (p.price || 0) / 1e6);
    if (n.type === 'r2') {
      cost += r.lambda * (p.classAUnits || 0) * (p.priceClassA || 0) / 1e6;
      cost += (p.storageGb || 0) * (p.priceStorage || 0) / monthSeconds;
    }
    if (n.type === 'durable_objects') {
      cost = r.billedRequests * (p.units || 0) * (p.price || 0) / 1e6;
      cost += r.doGbS / monthSeconds * (p.priceGBs || 0) / 1e6;
      cost += r.lambda * (p.rowsRead || 0) * (p.priceRowRead || 0) / 1e6;
      cost += r.lambda * (p.rowsWritten || 0) * (p.priceRowWritten || 0) / 1e6;
      cost += (p.storedGb || 0) * (p.priceStoredGb || 0) / monthSeconds;
    }
    return cost;
  }

  function compute(nodes, edges, types, params, backlog, drops, hoursPerMonth) {
    const res = {};
    const inc = {}, out = {};
    nodes.forEach(n => { inc[n.id] = []; out[n.id] = []; });
    edges.forEach(e => {
      if (!out[e.from] || !inc[e.to]) return;
      const weight = e.weight == null ? 100 : e.weight;
      if (!(weight > 0)) return;
      out[e.from].push(e);
      inc[e.to].push(e.from);
    });
    const indeg = {};
    nodes.forEach(n => { indeg[n.id] = inc[n.id].length; });
    const q = nodes.filter(n => indeg[n.id] === 0).map(n => n.id);
    const order = [];
    while (q.length) {
      const id = q.shift();
      order.push(id);
      out[id].forEach(e => { indeg[e.to]--; if (indeg[e.to] === 0) q.push(e.to); });
    }
    const byId = new Map(nodes.map(n => [n.id, n]));
    const lambda = {}, outLambda = {}, lat = {}, arrive = {};
    nodes.forEach(n => { lambda[n.id] = 0; outLambda[n.id] = 0; lat[n.id] = 0; arrive[n.id] = 0; });
    order.forEach(id => {
      const n = byId.get(id);
      if (!n) return;
      const p = params[id] || n.p || {};
      const def = types[n.type] || {};
      if (def.source) {
        res[id] = Object.assign(emptyResult(), { lambda: p.rate, out: p.rate });
        outLambda[id] = p.rate;
      } else {
        const r = emptyResult();
        let waitS = 0;
        if (n.type === 'queues') {
          const cap = capacity(p);
          r.capacity = cap;
          r.util = lambda[id] > 0 ? (cap > 0 ? lambda[id] / cap : 1) : 0;
          waitS = queueWait(backlog[id] || 0, cap, p, lambda[id]);
          outLambda[id] = forward(lambda[id], p, true);
        } else {
          let queueUtil = 0;
          if (p.concurrency > 0 && p.latency > 0) {
            const mu = 1000 / p.latency;
            queueUtil = lambda[id] / (mu * p.concurrency);
          }
          if (n.type === 'durable_objects') {
            const dobj = durableObject(lambda[id], p, p.latency / 1000, hoursPerMonth);
            r.util = Math.max(queueUtil, dobj.perObjectRate / dobj.objectLimit);
            r.billedRequests = dobj.billedRequests;
            r.doGbS = dobj.gbS;
            r.objects = dobj.objects;
            r.perObjectRate = dobj.perObjectRate;
            r.objectLimit = dobj.objectLimit;
            r.overloaded = r.util >= 1;
          } else r.util = queueUtil;
          if (r.util >= 1) waitS = MODEL.saturatedWaitS;
          else if (r.util > 0.005) {
            const mu = 1000 / p.latency;
            const C = erlangC(lambda[id] / mu, Math.max(1, Math.round(p.concurrency)));
            waitS = C / Math.max(0.0001, p.concurrency * mu - lambda[id]);
          }
          outLambda[id] = lambda[id];
        }
        const latS = p.latency / 1000 + waitS;
        lat[id] = latS;
        const hit = n.type === 'cache' ? Math.max(0, Math.min(100, p.hit)) / 100 : 0;
        outLambda[id] *= 1 - hit;
        r.lambda = lambda[id];
        r.lat = latS;
        r.hit = hit;
        r.out = outLambda[id];
        r.err = n.type !== 'queues' && r.util > 1 ? Math.min(0.85, (r.util - 1) * 0.55) : 0;
        r.backlog = backlog[id] || 0;
        r.drops = drops[id] || 0;
        res[id] = r;
      }
      out[id].forEach(e => {
        const flow = outLambda[id] * ((e.weight == null ? 100 : e.weight) / 100);
        if (flow <= 0) return;
        lambda[e.to] += flow;
        arrive[e.to] = Math.max(arrive[e.to], arrive[id] + lat[id]);
      });
    });
    let cpuRate = 0, rate = 0;
    nodes.forEach(n => {
      const r = res[n.id] || (res[n.id] = emptyResult());
      const p = params[n.id] || n.p || {};
      const def = types[n.type] || {};
      r.cost = nodeCost(n, r, p, def, hoursPerMonth);
      r.cpu = (p.cpuMs || 0) * r.lambda;
      cpuRate += r.cpu;
      rate += r.cost;
    });
    const pathLat = nodes.reduce((m, n) => {
      const r = res[n.id] || {};
      return r.lambda > 0 ? Math.max(m, (arrive[n.id] || 0) + (lat[n.id] || 0)) : m;
    }, 0);
    return { res, cpuRate, rate, pathLat };
  }

  function usage(nodes, res, params, hoursPerMonth) {
    const mult = hoursPerMonth * 3600;
    const u = { workersRequests: 0, workersCpuMs: 0, d1Rows: 0,
      doRequests: 0, doGbS: 0, doSqlRowsRead: 0, doSqlRowsWritten: 0, doSqlStoredGb: 0,
      kvReads: 0, queueOps: 0, r2ClassA: 0, r2ClassB: 0, r2StorageGb: 0,
      imagesTransformed: 0, imagesStored: 0, imagesDelivered: 0,
      streamStoredMinutes: 0, streamDeliveredMinutes: 0, workersAiNeurons: 0, cpuMsPerRequest: 0 };
    nodes.forEach(n => {
      const r = res[n.id] || {};
      const p = params[n.id] || n.p || {};
      const req = (r.lambda || 0) * mult;
      if (n.type === 'workers') {
        u.workersRequests += req;
        u.workersCpuMs += req * (p.cpuMs || 0);
      } else if (n.type === 'd1') u.d1Rows += req * (p.units || 0);
      else if (n.type === 'durable_objects') {
        const dobj = durableObject(r.lambda || 0, p, p.latency / 1000, hoursPerMonth);
        u.doRequests += dobj.billedRequests * mult;
        u.doGbS += dobj.gbS;
        u.doSqlRowsRead += req * (p.rowsRead || 0);
        u.doSqlRowsWritten += req * (p.rowsWritten || 0);
        u.doSqlStoredGb += p.storedGb || 0;
      } else if (n.type === 'kv') u.kvReads += req * (p.units || 0);
      else if (n.type === 'queues') {
        u.queueOps += Math.max(0, req * (p.units || 0) * MODEL.queueOpsPerMessage - (r.drops || 0) * mult);
      } else if (n.type === 'r2') {
        u.r2ClassA += req * (p.classAUnits || 0);
        u.r2ClassB += req * (p.units || 0);
        u.r2StorageGb += p.storageGb || 0;
      } else if (n.type === 'images') {
        u.imagesTransformed += p.uniqueTransforms || 0;
        u.imagesStored += p.imagesStored || 0;
        u.imagesDelivered += p.imagesDelivered || 0;
      } else if (n.type === 'stream') {
        u.streamStoredMinutes += p.minutesStored || 0;
        u.streamDeliveredMinutes += p.minutesDelivered || 0;
      } else if (n.type === 'workers_ai') {
        u.workersAiNeurons += req * ((p.inTokens || 0) * (p.neuronsIn || 0) +
          (p.outTokens || 0) * (p.neuronsOut || 0)) / 1e6;
      }
    });
    u.cpuMsPerRequest = u.workersRequests > 0 ? u.workersCpuMs / u.workersRequests : 0;
    return u;
  }

  return { DEFAULT_RETENTION, MODEL, capacity, forward, queueWait, step, advanceClock, erlangC,
    durableObject, model429, compute, usage };
});
