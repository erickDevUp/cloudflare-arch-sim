# Agent operator guide

Use `window.SIM_API` version 1 to load, edit, run, inspect, and export architectures without driving DOM controls. It is the stable browser-facing agent contract. `window.__SIM__`, HTTP `/scenario`, SSE, and DOM controls remain available for compatibility but are not part of the v1 stability promise.

## Quick path

Build and start the live channel:

```sh
npm ci
npm run build
npm run dev -- --port 8788
```

Open `http://127.0.0.1:8788/` in Orca's browser, then run:

```js
const api = window.SIM_API;

api.pause();
api.reset();

const loaded = api.loadScenario({
  version: 1,
  name: 'Static site candidate',
  nodes: [
    { id: 'traffic', type: 'traffic', p: { rate: 200 } },
    { id: 'cache', type: 'cache', p: { hit: 80 } },
    { id: 'workers', type: 'workers', p: { latency: 20, cpuMs: 5 } },
    { id: 'assets', type: 'r2' }
  ],
  edges: [
    { from: 'traffic', to: 'cache' },
    { from: 'cache', to: 'workers' },
    { from: 'workers', to: 'assets' }
  ]
});

if (!loaded.ok) throw new Error(loaded.error.message);

const patched = api.setParams('cache', { hit: 90 });
if (!patched.ok) throw new Error(patched.error.message);

api.start({ speed: 60 });
await new Promise(resolve => setTimeout(resolve, 250));
api.pause();

const state = api.getState().data;
const scenario = api.exportScenario().data;
```

Record `state.warnings`, `state.assumptions`, and `state.provenance` with any design conclusion. API mutations are local to the page; use the legacy HTTP channel when the scenario must be persisted or shared.

## v1 contract

`window.SIM_API.version` is `1`. Every method is synchronous and returns one envelope:

```js
{ ok: true, data, requestId }
{ ok: false, error: { code, message, details? }, requestId }
```

Request IDs are deterministic within a page instance: `sim-v1-000001`, `sim-v1-000002`, and so on. Every call consumes an ID, including failed validation. Reloading the page restarts the sequence; IDs are not globally unique.

| Method | Success `data` | Behavior |
|---|---|---|
| `loadScenario(scenario)` | `{ scenario, warnings }` | Validates the whole scenario, rejects unsupported nodes/params, computes a candidate model, then installs it atomically. Fits the view. |
| `setParams(nodeId, patch)` | `{ nodeId, params }` | Validates the entire patch before updating one node. Recomputes metrics and preserves all other nodes. |
| `start(options?)` | `{ running, speed, time }` | Starts the loop. Optional `{ speed }` accepts an integer from 1 through 7200. |
| `pause()` | `{ running, speed, time }` | Stops advancement without resetting counters. |
| `reset()` | `{ running, speed, time }` | Clears time, spend, requests, model spend, chaos, backlog, and drops. Keeps architecture, running state, and speed. |
| `getState()` | Structured snapshot | Returns scenario, simulation, billing, node metrics, assumptions, provenance, and warnings without mutating state. |
| `exportScenario()` | Canonical scenario | Returns an isolated, normalized scenario object. Does not persist or POST. |

### Error codes

| Code | Meaning |
|---|---|
| `INVALID_SCENARIO` | Root shape, version, node/edge data, defaults, ranges, or lossy normalization failed. |
| `UNSUPPORTED_NODE` | A node type is not in the supported catalog. |
| `UNKNOWN_NODE` | `setParams` targeted a missing or unsupported node id. |
| `INVALID_PARAMS` | A scenario param or patch is unknown, missing, non-finite, out of range, or outside an enum. |
| `INVALID_STATE` | The current scenario or simulation snapshot is not usable. |
| `INTERNAL_ERROR` | The host threw unexpectedly. The message is included without a stack. |

### Atomicity and fail-closed rules

- Validate before mutation. A failure leaves the previous scenario, params, runtime counters, and metrics unchanged.
- Unknown node types are rejected by v1 even though the lossless storage layer can preserve them.
- Unknown node params are rejected by v1. Unknown root, node, and edge fields remain preserved and appear as load warnings.
- Node ids that collide with `Object.prototype` names are rejected.
- A supplied scenario `version` must be `1`; an omitted version normalizes to `1`.
- `nodes` must be an array. Empty scenarios are valid.
- `loadScenario` resets Queue backlog/drops but does not reset time, spend, running state, speed, plan, budget, base fee, or chaos.
- `setParams`, `loadScenario`, and `exportScenario` do not write to `/scenario`.
- Pause before `reset()` when a zero-time snapshot is required; reset preserves the current running state.

The authoritative schema remains [src/scenario.js](../src/scenario.js). Defaults, editable ranges, enums, verified notes, and source links come from [src/catalog.js](../src/catalog.js). Legacy `workers_ai` nodes with external token prices still migrate to `external_model`.

## State snapshot

`getState().data` contains:

| Field | Meaning |
|---|---|
| `version` | API contract version. |
| `scenario` | Canonical architecture currently loaded. |
| `simulation` | `time`, `running`, `speed`, `spent`, `rate`, `pathLat`, `requests`, `modelSpent`, `cpuRate`, `baseFee`, `budget`, and active chaos keys. |
| `plan` | Current `free`, `paid`, or `custom` plan. |
| `usage` | Modeled monthly Cloudflare totals by pricing dimension. |
| `monthly` | Plan base, overage, total, lines, exceeded limits, and unverified dimensions. |
| `modelSpend` | External-model monthly projection `{ set, total }`; never part of Cloudflare spend. |
| `nodes` | Known nodes keyed by id, including Queue and Durable Object fields. |
| `assumptions` | Explicit editable/model conventions such as requests per user per month. |
| `provenance` | Pricing `asOf`, sources and dimensions, plus each node's verified note, source, model note, and param classifications. |
| `warnings` | Structured warnings for unsupported boot data, unknown params, cycles, unverified pricing, unset model spend, Queue backlog/expiry, and Durable Object overload. |

### Per-node metrics

| Field | Meaning |
|---|---|
| `lambda`, `out` | Input and forwarded request rates in requests/s. |
| `util`, `err` | Utilization fraction and modeled error fraction, both 0–1. |
| `lat`, `cost` | Service plus queue wait in seconds and Cloudflare usage in USD/s. |
| `capacity`, `backlog`, `drops` | Queue service capacity, queued messages, and retention-expiry drops/s. |
| `billedRequests`, `doGbS` | Durable Object billed requests/s and monthly GB-s. |
| `objects`, `perObjectRate`, `objectLimit`, `overloaded` | Durable Object sharding and limit state. |

Flow follows graph edges with full fan-out; edge `weight` does not affect physics. Ordinary nodes use M/M/c with Erlang-C, caches forward only misses, and only Queue nodes throttle into backlog. See [src/app.js](../src/app.js) and [src/engine.js](../src/engine.js).

### Assumptions and provenance

V1 labels every scenario param as an `editable_model_assumption`, including sourced price defaults, because agents can edit them. Verified platform facts are exposed separately through:

- `provenance.pricing.dimensions`, including verified flags, prices, allowances, and source links from [src/pricing.js](../src/pricing.js).
- `provenance.nodes[id].verified` and `.source` from the catalog.
- `provenance.nodes[id].note` for modeling assumptions and limits.

This separation prevents a sourced product price from being mistaken for a measured workload or capacity result.

## Workflow patterns

### Static site

Model `traffic -> cache -> workers -> r2`. Vary cache hit ratio, Worker latency/CPU, and R2 Class B units. Compare monthly totals and critical-path latency after pausing.

### Event-driven Queue

Model `traffic -> workers -> queues -> workers -> r2`. Set Queue concurrency/latency below arrival rate, start at a known speed, then pause and inspect `capacity`, `backlog`, `drops`, and `QUEUE_BACKLOG`/`QUEUE_EXPIRY` warnings.

### AI retrieval

Model `traffic -> workers -> ai_gateway -> workers_ai` with a `workers -> vectorize` branch. Native Workers AI contributes Neuron usage to Cloudflare spend. Use `external_model` only for third-party token spend, and populate all four token fields before treating `modelSpend` as set.

The loop uses `requestAnimationFrame` and wall-clock deltas. Equal wall-clock waits do not guarantee equal simulated time, and chaos expiries also use real time. V1 controls are independent of DOM refs, but they are not a deterministic clock or time-travel interface.

## Legacy compatibility

### `window.__SIM__`

| Method | Legacy return | Compatibility |
|---|---|---|
| `load(raw)` | `boolean` | Still validates and applies locally. Retains permissive opaque-node behavior for existing callers. |
| `export()` | Scenario object | Same canonical architecture export. |
| `getState()` | State snapshot | Existing top-level fields remain; speed, counters, plan inputs, and chaos were added additively. |

New agents should use `window.SIM_API` for structured errors and atomic fail-closed behavior. Existing DOM controls remain wired to the same shared run/reset/speed functions.

### HTTP scenario channel and SSE

[serve.mjs](../serve.mjs) still implements the unversioned loopback channel:

| Endpoint | Behavior |
|---|---|
| `GET /scenario` | Returns stored bytes untouched. Missing or invalid JSON returns 500. |
| `POST /scenario` | Requires JSON with a `nodes` array and a body no larger than 1 MB. Validates, preserves stored unknown data, writes atomically, and broadcasts. |
| `GET /events` | SSE stream with `{ clientId, scenario }` after successful POSTs. |

A successful POST returns `{ "ok": true, "warning": ... }`. Validation failures return 400, unsupported content type returns 415, oversized bodies return 413, and write failures return 500. SSE has no replay, event id, heartbeat, or run-state synchronization.

There is no HTTP v1 endpoint. A full HTTP contract would need page-local simulation state, controls, and request identity that the current stateless scenario channel does not own. Keep HTTP v1 as a follow-up rather than adding a generic server framework.

```sh
curl --fail --silent --show-error http://127.0.0.1:8788/scenario -o candidate.json
curl --fail --silent --show-error -X POST http://127.0.0.1:8788/scenario \
  -H 'content-type: application/json' \
  --header 'x-client-id: agent-candidate-1' \
  --data-binary @candidate.json
```

The server pins allowed loopback `Host` values and rejects foreign or `null` origins. It is not authenticated; do not expose it to an untrusted network.

## Known limitations

- This is a rate model, not a load test or Cloudflare emulator. It does not model retries, variable batches, distributed coordination, storage/egress, or real provider capacity.
- Cycles are skipped by the topological pass, so cycle-dependent nodes receive zero traffic and produce a warning.
- Durable Object arrivals are assumed evenly sharded; active duration does not model individual connection schedules or pending I/O.
- V1 has no subscription, persistence, time-travel, explicit `advance(seconds)`, MCP, or CLI JSON interface.
- Static HTML has no persistence; only `serve.mjs` provides the file-backed channel.
- The API validates architecture and params, but cannot make modeled prices or capacity into measured production facts.

## References

- [AGENTS.md](../AGENTS.md) — repository change workflow.
- [agent-playbook.md](agent-playbook.md) — executable repository recipes.
- [src/agent-api.js](../src/agent-api.js) — v1 validation, results, snapshot, and factory.
- [src/scenario.js](../src/scenario.js) — schema, validation, merge, and hash encoding.
- [src/catalog.js](../src/catalog.js) — node definitions, defaults, bounds, and provenance notes.
- [src/app.js](../src/app.js) — host wiring, controls, simulation loop, and metrics.
- [src/engine.js](../src/engine.js) — queue capacity, backlog, retention, and Durable Object helpers.
- [src/pricing.js](../src/pricing.js) — Cloudflare/model spend separation and pricing provenance.
- [serve.mjs](../serve.mjs) — legacy HTTP and SSE behavior.
