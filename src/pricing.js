// Cloudflare plan pricing, verified against the live docs.
// Every unit price and included allowance lives in DIMS. Prices without a
// verified source stay out of the total and are surfaced as "unverified".
(function (root) {
  const HOURS_PER_MONTH = 730;

  const SOURCES = {
    workers: 'https://developers.cloudflare.com/workers/platform/pricing/',
    d1: 'https://developers.cloudflare.com/d1/platform/pricing/'
  };

  const PLANS = {
    free: { base: 0 },
    paid: { base: 5 },
    custom: { base: 0 }
  };

  const DIMS = [
    {
      id: 'workersRequests', label: 'Workers requests', unit: 1e6,
      price: 0.30, paidIncluded: 1e7, freeDaily: 100000,
      verified: true, source: SOURCES.workers
    },
    {
      id: 'workersCpuMs', label: 'Workers CPU', unit: 1e6,
      price: 0.02, paidIncluded: 3e7, freePerRequest: 10,
      verified: true, source: SOURCES.workers
    },
    {
      id: 'd1Rows', label: 'D1 rows read', unit: 1e6,
      price: 0.001, paidIncluded: 25e9, freeDaily: 5e6,
      verified: true, source: SOURCES.d1
    },
    {
      id: 'doRequests', label: 'Durable Objects requests', unit: 1e6,
      price: 0.15, paidIncluded: 1e6, freeDaily: 100000,
      verified: true, source: SOURCES.workers
    },
    {
      id: 'doGbS', label: 'Durable Objects duration', unit: 1e6,
      price: 12.5, paidIncluded: 4e5, freeDaily: 13000,
      verified: true, source: SOURCES.workers
    },
    {
      id: 'kvReads', label: 'KV reads', unit: 1e6,
      price: 0.50, paidIncluded: 1e7, freeDaily: 100000,
      verified: true, source: SOURCES.workers
    },
    {
      id: 'queueOps', label: 'Queues operations', unit: 1e6,
      price: 0.40, paidIncluded: 1e6, freeDaily: 10000,
      verified: true, source: SOURCES.workers
    }
  ];

  // Pure monthly money math. usage is monthly totals; model spend is
  // deliberately not part of it.
  function monthlyCost(plan, usage) {
    const u = usage || {};
    const rateMonthly = +u.rateMonthly || 0;
    const verified = DIMS.filter(d => d.verified);
    const unverified = DIMS.filter(d => !d.verified).map(d => d.id);
    const lines = [];
    const exceeded = [];

    if (plan === 'free') {
      verified.forEach(d => {
        const used = +u[d.id] || 0;
        if (!used) return;
        let line;
        if (d.freePerRequest != null) {
          const per = +u.cpuMsPerRequest || 0;
          line = {
            id: d.id, label: d.label, used: per, limit: d.freePerRequest,
            period: 'per request', ratio: per / d.freePerRequest, over: per > d.freePerRequest, cost: 0
          };
        } else {
          const limit = d.freeDaily * HOURS_PER_MONTH / 24;
          line = {
            id: d.id, label: d.label, used, limit, daily: d.freeDaily,
            period: 'per day', ratio: used / limit, over: used > limit, cost: 0
          };
        }
        lines.push(line);
        if (line.over) exceeded.push(line);
      });
      return { plan, base: 0, overage: 0, total: 0, rateMonthly, lines, exceeded, unverified };
    }

    if (plan === 'paid') {
      let overage = 0;
      verified.forEach(d => {
        const used = +u[d.id] || 0;
        if (!used) return;
        const over = Math.max(0, used - d.paidIncluded);
        const cost = over / d.unit * d.price;
        overage += cost;
        lines.push({
          id: d.id, label: d.label, used, included: d.paidIncluded,
          over, cost, ratio: used / d.paidIncluded
        });
      });
      const base = PLANS.paid.base;
      return { plan, base, overage, total: base + overage, rateMonthly, lines, exceeded, unverified };
    }

    const base = +u.baseFee || 0;
    return {
      plan: 'custom', base, overage: 0, total: base + rateMonthly,
      rateMonthly, lines, exceeded, unverified
    };
  }

  // The simulation accumulates dollars per simulated second. Converting that
  // rate to a monthly figure is this module's job, so the 3600 factor can
  // never be dropped at a call site again.
  function monthlyUsage(ratePerSecond) {
    return (+ratePerSecond || 0) * 3600 * HOURS_PER_MONTH;
  }

  // The model bucket is separate by design: it is computed only from the
  // user-entered token prices and never enters the Cloudflare total. It stays
  // unset until every token field is present.
  const TOKEN_FIELDS = ['inPrice', 'outPrice', 'inTokens', 'outTokens'];
  function modelSpend(models) {
    const list = models || [];
    if (!list.length) return { set: false, total: 0 };
    let total = 0;
    for (const m of list) {
      const p = (m && m.p) || {};
      if (TOKEN_FIELDS.some(k => p[k] == null)) return { set: false, total: 0 };
      const perRequest = (p.inTokens * p.inPrice + p.outTokens * p.outPrice) / 1e6;
      total += monthlyUsage((+m.lambda || 0) * perRequest);
    }
    return { set: true, total };
  }

  const api = {
    asOf: '2026-11-21', hoursPerMonth: HOURS_PER_MONTH, sources: SOURCES,
    plans: PLANS, dims: DIMS, monthlyCost, monthlyUsage, modelSpend
  };
  root.PRICING = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
