import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { monthlyCost } = require('../src/pricing.js');

const usage = over => Object.assign({
  rateMonthly: 0, workersRequests: 0, workersCpuMs: 0, d1Rows: 0,
  doRequests: 0, doGbS: 0, kvReads: 0, queueOps: 0, cpuMsPerRequest: 0
}, over);

test('free plan: $0 base and names the exceeded limit', () => {
  const r = monthlyCost('free', usage({ workersRequests: 31.5e6, cpuMsPerRequest: 6 }));
  assert.equal(r.base, 0);
  assert.equal(r.total, 0);
  assert.ok(r.exceeded.some(l => l.id === 'workersRequests'));
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

test('model spend never enters the Cloudflare total', () => {
  const withModel = usage({ workersRequests: 15e6, workersCpuMs: 105e6, modelSpend: 9999 });
  assert.equal(monthlyCost('paid', withModel).total.toFixed(2), '8.00');
  assert.equal(monthlyCost('free', withModel).total, 0);
  assert.equal(monthlyCost('custom', Object.assign({}, withModel, { baseFee: 0, rateMonthly: 0 })).total, 0);
});
