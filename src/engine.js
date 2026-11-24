/* Queue physics shared by the browser engine and the node tests.
   Pure functions: simulated seconds in, rates/messages out. No DOM, no wall clock. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QUEUE_ENGINE = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const DEFAULT_RETENTION = 345600; // 4 days, in simulated seconds

  // Service capacity in requests/s. latency is in ms; the engine's mu is 1000/latency.
  function capacity(p) {
    if (!(p.concurrency > 0) || !(p.latency > 0)) return 0;
    return p.concurrency / (p.latency / 1000);
  }

  // A Queue forwards at most its service capacity; other nodes forward full rate.
  function forward(lambda, p, isQueue) {
    if (!isQueue) return lambda;
    const cap = capacity(p);
    return cap > 0 ? Math.min(lambda, cap) : lambda;
  }

  // Evolve a Queue's backlog over dt simulated seconds.
  // Invariant: backlog = cap * wait, where wait is the FIFO wait a just-arrived
  // message would face (Little's law). Messages whose wait exceeds retention
  // expire; the excess is reported as drops/s. Simulated seconds only.
  function step(backlog, lambda, cap, dt, retention) {
    const t = retention == null ? DEFAULT_RETENTION : retention;
    if (!(dt > 0) || !(cap > 0)) return { backlog: Math.max(0, backlog), drops: 0 };
    const wait = backlog / cap;
    const nextWait = Math.max(0, wait + (lambda / cap - 1) * dt);
    // FIFO: messages older than retention leave the queue as drops.
    const keptWait = t > 0 ? Math.min(nextWait, t) : nextWait;
    const expiredMsgs = (nextWait - keptWait) * cap;
    return {
      backlog: keptWait * cap,
      drops: expiredMsgs / dt
    };
  }

  return { DEFAULT_RETENTION: DEFAULT_RETENTION, capacity: capacity, forward: forward, step: step };
});
