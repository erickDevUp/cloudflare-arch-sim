import test from 'node:test';
import assert from 'node:assert/strict';
import QE from '../src/engine.js';

const queue = (concurrency, latency, retention) =>
  ({ concurrency, latency, retention: retention == null ? QE.DEFAULT_RETENTION : retention });

test('queue with 5/s in and capacity 2/s forwards 2/s', () => {
  const p = queue(2, 1000); // capacity = 2/(1s) = 2/s
  assert.equal(QE.capacity(p), 2);
  assert.equal(QE.forward(5, p, true), 2);
  // non-queues keep the full rate
  assert.equal(QE.forward(5, p, false), 5);
  // capacity above input passes everything through (owner's 1500/2000ms case)
  assert.equal(QE.forward(5, queue(1500, 2000), true), 5);
});

test('backlog grows when lambda > capacity and drains when lambda < capacity', () => {
  const cap = 2; // 2/s
  const step = QE.step(0, 5, cap, 10, 345600); // 10 simulated seconds at +3/s
  assert.equal(step.backlog, 30);
  assert.equal(step.drops, 0);

  const drained = QE.step(step.backlog, 0, cap, 5, 345600); // drain at 2/s for 5 s
  assert.equal(drained.backlog, 20);
  assert.equal(drained.drops, 0);
});

test('messages drop once FIFO wait exceeds retention', () => {
  const cap = 2, retention = 100, dt = 10;
  const first = QE.step(0, 5, cap, dt, retention);
  assert.equal(first.backlog, 30);
  assert.equal(first.drops, 0);
  let b = first.backlog, drops = 0;
  for (let i = 0; i < 10; i++) {
    const s = QE.step(b, 5, cap, dt, retention);
    b = s.backlog;
    drops = Math.max(drops, s.drops);
  }
  assert.ok(b <= cap * retention + 1e-9);
  assert.ok(drops > 0);
});

test('retention 0 disables expiry: backlog grows unbounded, nothing drops', () => {
  const unlimited = QE.step(0, 5, 2, 10, 0);
  assert.equal(unlimited.backlog, 30);
  assert.equal(unlimited.drops, 0);
});

test('advanceClock integrates exact simulated time and splits at chaos expiry', () => {
  const runtime = { time: 0, spent: 0, requests: 0, modelSpent: 0, chaos: { m429: 5 } };
  const segments = [];
  const settled = [];
  QE.advanceClock(runtime, 10, (dt, time) => {
    segments.push([dt, time]);
    return { rate: time < 5 ? 2 : 4, requests: time < 5 ? 3 : 5, modelRate: time < 5 ? 1 : 2 };
  }, time => settled.push(time));
  assert.deepEqual(segments, [[5, 0], [5, 5]]);
  assert.deepEqual(settled, [5, 10]);
  assert.equal(runtime.time, 10);
  assert.equal(runtime.spent, 30);
  assert.equal(runtime.requests, 40);
  assert.equal(runtime.modelSpent, 15);
  assert.deepEqual(runtime.chaos, {});
});

test('Erlang wait stays continuous across the 400-server cap', () => {
  const wait = c => QE.erlangC(200, c) / (c - 200);
  const below = wait(399);
  const at = wait(400);
  const above = wait(401);
  assert.ok(Number.isFinite(at));
  assert.ok(at > 0);
  assert.ok(Math.abs(at - below) < 0.0001);
  assert.ok(Math.abs(above - at) < 0.0001);
  assert.ok(above < at && at < below);
});

function flowModel(edges) {
  const nodes = [
    { id: 'source', type: 'traffic' },
    { id: 'main', type: 'workers' },
    { id: 'secondary', type: 'workers' },
    { id: 'off', type: 'workers' }
  ];
  const types = { traffic: { source: true }, workers: {} };
  const params = {
    source: { rate: 10 },
    main: { latency: 100, concurrency: 100 },
    secondary: { latency: 100, concurrency: 100 },
    off: { latency: 100, concurrency: 100 }
  };
  return QE.compute(nodes, edges, types, params, {}, {}, 730);
}

test('an edge without a weight carries the full source rate', () => {
  const model = flowModel([{ from: 'source', to: 'main' }]);
  assert.equal(model.res.main.lambda, 10);
});

test('90/10 edge shares split 10/s into 9/s and 1/s', () => {
  const model = flowModel([
    { from: 'source', to: 'main', weight: 90 },
    { from: 'source', to: 'secondary', weight: 10 }
  ]);
  assert.equal(model.res.main.lambda, 9);
  assert.equal(model.res.secondary.lambda, 1);
  assert.equal(model.pathLat, 0.1);
});

test('a zero-share edge carries no traffic or critical-path latency', () => {
  const model = flowModel([{ from: 'source', to: 'off', weight: 0 }]);
  assert.equal(model.res.off.lambda, 0);
  assert.equal(model.pathLat, 0);
});

test('multiple 100% edges fan out the full source rate', () => {
  const model = flowModel([
    { from: 'source', to: 'main', weight: 100 },
    { from: 'source', to: 'secondary', weight: 100 }
  ]);
  assert.equal(model.res.main.lambda, 10);
  assert.equal(model.res.secondary.lambda, 10);
});
