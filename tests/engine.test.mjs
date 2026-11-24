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
  const first = QE.step(0, 5, cap, dt, retention); // wait reaches 15 s
  assert.equal(first.backlog, 30);
  assert.equal(first.drops, 0);

  // drive simulated time forward until wait would exceed retention
  let b = first.backlog, drops = 0;
  for (let i = 0; i < 10; i++) {
    const s = QE.step(b, 5, cap, dt, retention);
    b = s.backlog;
    drops = Math.max(drops, s.drops);
  }
  // backlog is capped at capacity * retention
  assert.ok(b <= cap * retention + 1e-9);
  assert.ok(drops > 0, 'expired messages are counted as drops/s');
  // retention 0 disables expiry: backlog grows unbounded, nothing drops
  const unlimited = QE.step(0, 5, cap, dt, 0);
  assert.equal(unlimited.backlog, 30);
  assert.equal(unlimited.drops, 0);
});
