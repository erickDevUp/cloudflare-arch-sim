import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pricing = require('../src/pricing.js');
const { monthlyCost, monthlyUsage, modelSpend, dims, sources } = pricing;

// catalog.js is a plain browser script; give it the window it writes to.
globalThis.window = globalThis;
require('../src/catalog.js');
const { CATALOG } = globalThis;

const usage = over => Object.assign({
  rateMonthly: 0, workersRequests: 0, workersCpuMs: 0, d1Rows: 0,
  doRequests: 0, doGbS: 0, kvReads: 0, queueOps: 0, cpuMsPerRequest: 0
}, over);

test('free plan: $0 base and names the exceeded limit', () => {
  const r = monthlyCost('free', usage({ workersRequests: 31.5e6, cpuMsPerRequest: 6 }));
  assert.equal(r.base, 0);
  assert.equal(r.total, 0);
  const req = r.exceeded.find(l => l.id === 'workersRequests');
  assert.ok(req, 'workers requests must exceed the free limit');
  // The limit is the monthly equivalent of the daily allowance, so the UI can
  // render limit and usage in the same unit.
  assert.equal(req.limit, 100000 * 730 / 24);
  assert.ok(!r.exceeded.some(l => l.id === 'workersCpuMs'));
});

test('paid plan: $5 base plus request and CPU overage', () => {
  // Cloudflare pricing doc example 1: 15M requests at 7ms CPU.
  const r = monthlyCost('paid', usage({ workersRequests: 15e6, workersCpuMs: 105e6 }));
  assert.equal(r.base, 5);
  assert.equal(r.overage.toFixed(2), '3.00');
  assert.equal(r.total.toFixed(2), '8.00');
});

test('custom plan: base fee plus usage, no allowances', () => {
  const r = monthlyCost('custom', usage({ baseFee: 10, rateMonthly: 20, workersRequests: 999e6 }));
  assert.equal(r.overage, 0);
  assert.equal(r.total, 30);
  assert.equal(r.lines.length, 0);
});

test('monthlyUsage converts dollars per second into a month of simulated time', () => {
  assert.equal(monthlyUsage(1), 3600 * 730);
  assert.equal(monthlyUsage(0.5), 1800 * 730);
  assert.equal(monthlyUsage(undefined), 0);
});

test('custom plan bills the month derived from the Cloudflare per-second rate', () => {
  // Default template after model cost is excluded: ~$8.96/mo of Cloudflare usage.
  const perSecond = 8.96 / (3600 * 730);
  const r = monthlyCost('custom', { baseFee: 10, rateMonthly: monthlyUsage(perSecond) });
  assert.equal(r.total.toFixed(2), '18.96');
  assert.equal((r.total / 1000 * 100).toFixed(1), '1.9');
});

test('model spend stays in its own bucket, computed from token prices', () => {
  const bucket = modelSpend([
    { lambda: 4.8, p: { inPrice: 3, outPrice: 15, inTokens: 1000, outTokens: 500 } }
  ]);
  assert.equal(bucket.set, true);
  // (1000 * 3 + 500 * 15) / 1e6 per request, 4.8 req/s, 730h month.
  assert.equal(bucket.total.toFixed(2), '132451.20');

  const missing = [{ lambda: 4.8, p: { inPrice: 3, outPrice: null, inTokens: 1000, outTokens: 500 } }];
  assert.equal(modelSpend(missing).set, false);
  assert.equal(modelSpend([]).set, false);

  // The Cloudflare table has no model dimension, and no catalog node may feed
  // a legacy model price into the Cloudflare rate.
  assert.deepEqual(dims.filter(d => /model|token/i.test(d.id)), []);
  const model = CATALOG.types.external_model;
  assert.equal(model.cloudflare, false);
  assert.equal(model.p.price, undefined);
  assert.equal(model.p.units, undefined);
  assert.equal(CATALOG.types.workers_ai.cloudflare, undefined);
  assert.equal(CATALOG.types.workers_ai.priceNeurons, dims.find(d => d.id === 'workersAiNeurons').price);
});

test('catalog unit prices match the plan pricing table', () => {
  const byId = id => dims.find(d => d.id === id);
  const price = (type, key) => key === 'priceCpu' || key === 'priceNeurons'
    ? CATALOG.types[type][key] : CATALOG.types[type].p[key];
  const pairs = [
    ['workers', 'price', 'workersRequests'],
    ['workers', 'priceCpu', 'workersCpuMs'],
    ['durable_objects', 'price', 'doRequests'],
    ['durable_objects', 'priceGBs', 'doGbS'],
    ['durable_objects', 'priceRowRead', 'doSqlRowsRead'],
    ['durable_objects', 'priceRowWritten', 'doSqlRowsWritten'],
    ['durable_objects', 'priceStoredGb', 'doSqlStoredGb'],
    ['d1', 'price', 'd1Rows'],
    ['kv', 'price', 'kvReads'],
    ['queues', 'price', 'queueOps'],
    ['r2', 'price', 'r2ClassB'],
    ['r2', 'priceClassA', 'r2ClassA'],
    ['r2', 'priceStorage', 'r2StorageGb'],
    ['images', 'pricePerThousand', 'imagesTransformed'],
    ['images', 'priceStored', 'imagesStored'],
    ['images', 'priceDelivered', 'imagesDelivered'],
    ['stream', 'storagePrice', 'streamStoredMinutes'],
    ['stream', 'deliveryPricePerThousand', 'streamDeliveredMinutes'],
    ['workers_ai', 'priceNeurons', 'workersAiNeurons']
  ];
  pairs.forEach(([type, key, id]) => {
    assert.equal(price(type, key), byId(id).price,
      type + '.' + key + ' drifted from PRICING.dims.' + id + '.price');
  });
});

test('billable dimensions round up to the documented unit', () => {
  const requests = monthlyCost('paid', usage({ doRequests: 1.5e6 }));
  assert.equal(requests.lines.find(l => l.id === 'doRequests').billable, 1e6);
  assert.equal(requests.lines.find(l => l.id === 'doRequests').cost, 0.15);
  const duration = monthlyCost('paid', usage({ doGbS: 900000 }));
  assert.equal(duration.lines.find(l => l.id === 'doGbS').billable, 1e6);
  assert.equal(duration.lines.find(l => l.id === 'doGbS').cost, 12.5);
  const stream = monthlyCost('paid', usage({ streamStoredMinutes: 1 }));
  assert.equal(stream.lines.find(l => l.id === 'streamStoredMinutes').billable, 1000);
});

test('Workers AI uses the daily Neuron allocation and stays in Cloudflare spend', () => {
  const monthlyAllowance = 10000 * pricing.hoursPerMonth / 24;
  const r = monthlyCost('paid', usage({ workersAiNeurons: monthlyAllowance + 1000 }));
  assert.equal(r.lines.find(l => l.id === 'workersAiNeurons').cost, 0.011);
  assert.equal(r.total.toFixed(3), '5.011');
});

test('every verified dimension points at a declared source', () => {
  const declared = Object.values(sources);
  dims.filter(d => d.verified).forEach(d => {
    assert.ok(declared.includes(d.source), d.id + ' has an undeclared source');
  });
});
