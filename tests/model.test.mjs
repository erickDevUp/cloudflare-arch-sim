import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import QE from '../src/engine.js';
import scenario from '../src/scenario.js';
import pricing from '../src/pricing.js';

globalThis.window = globalThis;
createRequire(import.meta.url)('../src/catalog.js');
const catalog = globalThis.CATALOG;

const node = (id, type, p) => ({ id, type, p });
const chain = (...nodes) => ({
  version: 1,
  name: nodes.map(n => n.type).join(' '),
  nodes,
  edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }))
});

function run(input, plan = 'paid') {
  const validated = scenario.validate(input, catalog);
  assert.equal(validated.error, null);
  assert.equal(validated.dropped, 0);
  const s = validated.scenario;
  const params = Object.fromEntries(s.nodes.map(n => [n.id, n.p]));
  const model = QE.compute(s.nodes, s.edges, catalog.types, params, {}, {}, pricing.hoursPerMonth);
  const usage = QE.usage(s.nodes, model.res, params, pricing.hoursPerMonth);
  const monthly = pricing.monthlyCost(plan, Object.assign({}, usage, {
    rateMonthly: pricing.monthlyUsage(model.rate)
  }));
  return { scenario: s, model, usage, monthly };
}

const base = {
  traffic: { rate: 1, concurrency: 1, latency: 0, price: 0, units: 1 },
  cache: { concurrency: 1000000, latency: 2, price: 0, units: 1, hit: 0 },
  workers: { concurrency: 1000, latency: 10, price: 0.3, units: 1, cpuMs: 2 },
  queues: { concurrency: 2, latency: 1000, retention: 3600, price: 0.4, units: 1 },
  r2: { concurrency: 1000000, latency: 30, price: 0.36, units: 1 },
  durable_objects: { concurrency: 1000, latency: 20, price: 0.15, units: 1, priceGBs: 12.5 }
};

test('static Paid includes R2 Class B reads and matches the audit estimate', () => {
  const { usage, monthly } = run(chain(
    node('n1', 'traffic', Object.assign({}, base.traffic, { rate: 200 })),
    node('n2', 'cache', Object.assign({}, base.cache, { hit: 80 })),
    node('n3', 'workers', Object.assign({}, base.workers, { latency: 20, cpuMs: 5 })),
    node('n4', 'r2', base.r2)
  ));
  assert.ok(Math.abs(usage.r2ClassB - 40 * pricing.monthlyUsage(1)) < 1e-6);
  assert.equal(monthly.total.toFixed(2), '77.69');
});

test('Queues bill write read delete and event Paid matches the audit estimate', () => {
  const { usage, monthly, model } = run(chain(
    node('n1', 'traffic', Object.assign({}, base.traffic, { rate: 100 })),
    node('n2', 'workers', base.workers),
    node('n3', 'queues', base.queues),
    node('n4', 'workers', Object.assign({}, base.workers, { concurrency: 2, latency: 500, cpuMs: 5 })),
    node('n5', 'r2', base.r2)
  ));
  assert.equal(usage.queueOps, 100 * pricing.monthlyUsage(1) * 3);
  assert.equal(model.res.n4.lambda, 2);
  assert.equal(model.res.n3.err, 0);
  assert.equal(monthly.total.toFixed(2), '407.81');
});

test('commerce Paid includes R2 and three Queue operations', () => {
  const input = chain(
    node('n1', 'traffic', Object.assign({}, base.traffic, { rate: 120 })),
    node('n2', 'cache', Object.assign({}, base.cache, { hit: 65 })),
    node('n3', 'workers', Object.assign({}, base.workers, { latency: 30, cpuMs: 8 })),
    node('n4', 'd1', { concurrency: 50, latency: 50, price: 0.001, units: 25 }),
    node('n5', 'queues', Object.assign({}, base.queues, { concurrency: 50, latency: 20, retention: 345600 })),
    node('n6', 'workers', Object.assign({}, base.workers, { concurrency: 50, latency: 100, cpuMs: 5 })),
    node('n7', 'r2', base.r2)
  );
  input.edges = [
    { from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }, { from: 'n3', to: 'n4' },
    { from: 'n3', to: 'n5' }, { from: 'n5', to: 'n6' }, { from: 'n6', to: 'n7' }
  ];
  const { monthly } = run(input);
  assert.equal(monthly.total.toFixed(2), '264.51');
});

test('Queue backlog adds FIFO wait to node and path latency without request errors', () => {
  const input = chain(
    node('n1', 'traffic', Object.assign({}, base.traffic, { rate: 5 })),
    node('n2', 'queues', base.queues),
    node('n3', 'workers', base.workers)
  );
  const validated = scenario.validate(input, catalog).scenario;
  const params = Object.fromEntries(validated.nodes.map(n => [n.id, n.p]));
  const stepped = QE.step(0, 5, QE.capacity(params.n2), 10, params.n2.retention);
  const model = QE.compute(validated.nodes, validated.edges, catalog.types, params,
    { n2: stepped.backlog }, { n2: stepped.drops }, pricing.hoursPerMonth);
  assert.equal(stepped.backlog, 30);
  assert.equal(model.res.n2.backlog, 30);
  assert.equal(model.res.n2.err, 0);
  assert.equal(model.res.n2.out, 2);
  assert.equal(model.res.n2.lat, 16);
  assert.ok(model.pathLat >= 16);
  const expired = QE.compute(validated.nodes, validated.edges, catalog.types, params,
    { n2: stepped.backlog }, { n2: 3 }, pricing.hoursPerMonth);
  assert.ok(Math.abs(expired.res.n2.cost * pricing.monthlyUsage(1) -
    (5 * 3 - 3) * pricing.monthlyUsage(1) / 1e6 * 0.4) < 1e-9);
});

test('zero-capacity Queue retains messages and defines a finite expiry wait', () => {
  const p = { concurrency: 0, latency: 1000, retention: 100 };
  assert.equal(QE.forward(5, p, true), 0);
  assert.equal(QE.queueWait(0, 0, p, 5), 100);
  assert.deepEqual(QE.step(0, 5, 0, 10, 100), { backlog: 500, drops: 5 });
  assert.deepEqual(QE.step(0, 5, 0, 10, 0), { backlog: 50, drops: 0 });
});

test('one Durable Object overloads at 1500/s while 100 objects do not', () => {
  const input = chain(
    node('n1', 'traffic', Object.assign({}, base.traffic, { rate: 1500 })),
    node('n2', 'durable_objects', Object.assign({}, base.durable_objects, {
      transport: 'hibernatable', activeMs: 20
    }))
  );
  const one = run(input);
  assert.equal(one.model.res.n2.objects, 1);
  assert.equal(one.model.res.n2.perObjectRate, 1500);
  assert.equal(one.model.res.n2.overloaded, true);
  assert.equal(one.monthly.total.toFixed(2), '34.55');
  assert.notEqual(one.monthly.total.toFixed(2), '35.72');
  input.nodes[1].p.objects = 100;
  const pool = run(input);
  assert.equal(pool.model.res.n2.perObjectRate, 15);
  assert.equal(pool.model.res.n2.overloaded, false);
});

test('Durable Objects separate WebSocket request billing from shared duration', () => {
  const p = Object.assign({}, base.durable_objects, {
    objects: 100, transport: 'hibernatable', activeMs: 20, connections: 10,
    rowsRead: 2, rowsWritten: 1, storedGb: 6
  });
  const dobj = QE.durableObject(1500, p, 0.02, pricing.hoursPerMonth);
  assert.equal(dobj.billedRequests, 85);
  assert.equal(dobj.perObjectRate, 15);
  assert.equal(dobj.activeSeconds, 1500 * 0.02 * pricing.monthlyUsage(1));
  assert.equal(dobj.gbS, dobj.activeSeconds * QE.MODEL.doMemoryGb);
  const { usage } = run(chain(
    node('n1', 'traffic', Object.assign({}, base.traffic, { rate: 1500 })),
    node('n2', 'durable_objects', p)
  ));
  assert.equal(usage.doRequests, 85 * pricing.monthlyUsage(1));
  assert.equal(usage.doGbS, dobj.gbS);
  assert.equal(usage.doSqlRowsRead, 1500 * pricing.monthlyUsage(1) * 2);
  assert.equal(usage.doSqlRowsWritten, 1500 * pricing.monthlyUsage(1));
  assert.equal(usage.doSqlStoredGb, 6);
});

test('Durable Object duration caps overlap and honors explicit HTTP wall time', () => {
  const p = Object.assign({}, base.durable_objects, { objects: 1, transport: 'hibernatable', activeMs: 20 });
  const shared = QE.durableObject(1500, p, 0.02, pricing.hoursPerMonth);
  assert.equal(shared.activeSeconds, pricing.monthlyUsage(1));
  assert.equal(shared.gbS, pricing.monthlyUsage(1) * QE.MODEL.doMemoryGb);
  const http = QE.durableObject(10, Object.assign({}, p, { transport: 'http', activeSeconds: 1000000 }), 0.02, pricing.hoursPerMonth);
  assert.equal(http.activeSeconds, 1000000);
  const socket = QE.durableObject(10, Object.assign({}, p, { transport: 'websocket', objects: 2 }), 0.02, pricing.hoursPerMonth);
  assert.equal(socket.activeSeconds, 2 * pricing.monthlyUsage(1));
});

test('Images and Stream are rendered and billed instead of silently omitted', () => {
  const { scenario: s, usage, monthly, model } = run({
    version: 1,
    name: 'Media',
    nodes: [
      node('n1', 'traffic', Object.assign({}, base.traffic, { rate: 100 })),
      node('n2', 'images', { uniqueTransforms: 5000, pricePerThousand: 0.5 }),
      node('n3', 'stream', { minutesStored: 1000, minutesDelivered: 100000, storagePrice: 5, deliveryPricePerThousand: 1 })
    ],
    edges: [{ from: 'n1', to: 'n2' }, { from: 'n1', to: 'n3' }]
  });
  assert.deepEqual(s.nodes.map(n => n.type), ['traffic', 'images', 'stream']);
  assert.equal(usage.imagesTransformed, 5000);
  assert.equal(usage.streamStoredMinutes, 1000);
  assert.equal(usage.streamDeliveredMinutes, 100000);
  assert.equal(monthly.total.toFixed(2), '110.00');
  assert.ok(model.res.n2.cost > 0);
  assert.ok(model.res.n3.cost > 0);
});

test('native Workers AI enters Cloudflare spend while external models stay separate', () => {
  const input = chain(
    node('n1', 'traffic', Object.assign({}, base.traffic, { rate: 20 })),
    node('n2', 'workers_ai', { concurrency: 24, latency: 900, inTokens: 1000, outTokens: 500 }),
    node('n3', 'external_model', { concurrency: 24, latency: 900, inPrice: 3, outPrice: 15, inTokens: 1000, outTokens: 500 })
  );
  input.edges.push({ from: 'n1', to: 'n3' });
  const { scenario: s, usage, monthly, model } = run(input);
  assert.equal(s.nodes[1].type, 'workers_ai');
  assert.equal(s.nodes[2].type, 'external_model');
  assert.ok(usage.workersAiNeurons > 0);
  assert.ok(model.res.n2.cost > 0);
  assert.equal(model.res.n3.cost, 0);
  const external = pricing.modelSpend([{ p: s.nodes[2].p, lambda: 20 }]);
  assert.equal(external.set, true);
  assert.ok(external.total > 0);
  assert.ok(monthly.total < external.total);
});
