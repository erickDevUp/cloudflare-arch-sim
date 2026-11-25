# Agent operator guide

Use `window.SIM_API` version 1 to load, validate, edit, advance, inspect, export, and persist architectures without driving DOM controls. It is the stable browser-facing agent contract. `window.__SIM__`, HTTP `/scenario`, SSE, and DOM controls remain compatibility surfaces.

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
const caps = api.capabilities();
if (!caps.ok || !caps.data.deterministicClock) {
  throw new Error(caps.ok ? 'Deterministic clock unavailable' : caps.error.message);
}

const raw = {
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
};

const checked = api.validate(raw);
if (!checked.ok) throw new Error(checked.error.message);

const loaded = api.loadScenario(raw);
if (!loaded.ok) throw new Error(loaded.error.message);

const patched = api.setParams('cache', { hit: 90 });
if (!patched.ok) throw new Error(patched.error.message);

api.setSpeed(60);
const advanced = api.run({ seconds: 3600 });
if (!advanced.ok) throw new Error(advanced.error.message);

const state = api.getState().data;
const assessment = api.exportScenario({ assessment: true, provenance: true }).data;
const saved = await api.save();
if (!saved.ok) throw new Error(saved.error.message);
```

Record request IDs, `state.runId`, `state.scenarioRevision`, `state.warnings`, `state.assumptions`, `state.limitations`, and `assessment.provenance` with any design conclusion. `run()` advances exact simulated seconds; do not use wall-clock waits for assessments.

## v1 contract

`window.SIM_API.version` and `.apiVersion` are `1`. Every call returns one envelope:

```js
{ ok: true, data, requestId }
{ ok: false, error: { code, message, details? }, requestId }
```

All methods are synchronous except `save()` and `loadScenario(..., { persist: true })`, which return promises. Request IDs are deterministic within a page instance: `sim-v1-000001`, `sim-v1-000002`, and so on. Every call consumes an ID, including failed validation and asynchronous saves.

| Method | Success `data` | Behavior |
|---|---|---|
| `capabilities()` | Versions, supported node types, limits, clock and persistence status | Use before designing an assessment. |
| `validate(raw)` | `{ valid, scenario, warnings, unsupported }` | Strict, non-mutating validation with the same checks as a default load. |
| `loadScenario(raw, options?)` | `{ scenario, warnings, unsupported, scenarioRevision, scenarioHash, runId, dirty, save }` | Defaults to `{ resetRuntime: true, strict: true, persist: false }`; installs atomically and returns a fresh `runId`. |
| `setParams(nodeId, patch)` | `{ nodeId, params }` | Validates the whole patch before updating one node. Marks the scenario dirty. |
| `setSpeed(speed)` | Runtime identity/control state | Accepts an integer from 1 through 7200. |
| `start(options?)` | Runtime identity/control state | Starts the human wall-clock loop. Optional `{ speed }`. |
| `pause()` | Runtime identity/control state | Stops advancement without resetting counters. |
| `reset()` | Runtime identity/control state | Stops running, clears runtime only, preserves architecture/storage/speed/plan inputs, and returns a fresh `runId`. |
| `run(options)` | Runtime identity/control state | Pauses and advances exactly `{ seconds }`, up to 31536000 per call. |
| `getState()` | Structured snapshot | Returns identity, runtime, billing, node metrics, diagnostics, and provenance without mutating state. |
| `exportScenario(options?)` | Canonical scenario or `{ scenario, assessment?, provenance? }` | Defaults to the canonical scenario. Options accept `{ assessment, provenance }`. |
| `save()` | `{ revision, hash, scenario, eventId }` | Persists through `/scenario`; resolves only after a valid 2xx response. |

Short aliases `load`, `set`, `state`, and `export` remain available.

### Error codes

| Code | Meaning |
|---|---|
| `INVALID_SCENARIO` | Root shape, serialization, size, node/edge data, defaults, or lossy normalization failed. |
| `UNSUPPORTED_SCHEMA_VERSION` | Strict validation received a schema version other than 1. |
| `UNSUPPORTED_NODE_TYPE` | Strict validation received a node type outside the catalog. |
| `UNSUPPORTED_PARAMETER` | A scenario param or patch key is not defined for that node type. |
| `PARAMETER_OUT_OF_RANGE` | A numeric param is outside its catalog range. |
| `UNKNOWN_NODE` | `setParams` targeted a missing or unsafe node id. |
| `INVALID_PARAMS` | A param value, patch, or speed is malformed or outside an enum. |
| `INVALID_OPTIONS` | Method options are malformed or contain unknown keys. |
| `INVALID_STATE` | The current scenario or simulation snapshot is not usable. |
| `SAVE_FAILED` | The channel rejected the save, returned an invalid result, or failed locally. |
| `CHANNEL_UNAVAILABLE` | The page is static or cannot reach the scenario channel. |
| `STORAGE_CONFLICT` | Stored content changed after the loaded revision, or opaque node data prevents a safe merge. |
| `INTERNAL_ERROR` | The host threw unexpectedly. The message is included without a stack. |

### Atomicity and fail-closed rules

- Validate before mutation. A failure leaves the previous scenario, params, runtime counters, and metrics unchanged.
- Default strict mode rejects unsupported schema versions, node types, params, and out-of-range values. It never silently drops or normalizes them.
- An omitted scenario `version` normalizes to `1`. Unknown root, node, and edge fields remain preserved and appear as load warnings.
- `nodes` must be an array. Empty scenarios are valid. Unsafe `Object.prototype` node ids are rejected.
- `loadScenario` always returns a fresh `runId`. With `resetRuntime: true` it also stops running and clears time, spend, requests, model spend, chaos, Queue backlog, and drops. With `false`, runtime state is preserved while architecture changes.
- `persist: true` saves before installing. A failed save leaves the previous local architecture and runtime unchanged.
- `setParams`, `loadScenario` without `persist`, and `exportScenario` do not write to `/scenario`.
- `run()` never reads `requestAnimationFrame` or wall-clock time. Chaos deadlines also use simulated time, so equal starting states and seconds produce equal assessment state.
- `reset()` is runtime-only. It does not clear dirty state, save errors, scenario identity, plan, budget, base fee, or speed.
- `save()` sends the loaded ETag as `If-Match`. A 2xx response clears `dirty` only if the scenario has not changed while the request was in flight. Failures keep `dirty: true` and expose a structured `saveError`.

The authoritative schema remains [src/scenario.js](../src/scenario.js). Defaults, editable ranges, enums, verified notes, and source links come from [src/catalog.js](../src/catalog.js). Legacy `workers_ai` nodes with external token prices still migrate to `external_model`.

## State snapshot

`getState().data` contains:

| Field | Meaning |
|---|---|
| `apiVersion`, `schemaVersion`, `modelVersion` | API, scenario schema, and rate-model identities. |
| `scenarioRevision`, `scenarioHash` | Persisted revision and SHA-256 content hash; both are `null` while the current scenario is dirty. |
| `runId` | Fresh identity for each load and reset. |
| `time`, `running`, `speed` | Simulated seconds, loop state, and simulated-seconds per real-second multiplier. |
| `plan`, `budget`, `baseFee` | Current Cloudflare plan and monthly inputs. |
| `requestCount` | Source request arrivals accumulated over simulated time. |
| `dirty`, `saving`, `saveError` | Persistence status for the current scenario. |
| `scenario` | Canonical architecture currently loaded. |
| `simulation` | Compatibility runtime block with time, counters, rates, chaos, plan inputs, and identity. |
| `cloudflare` | Rate, spend, usage, monthly bill, complete allowances, overage, exceeded limits, unverified dimensions, and units. |
| `model` | `{ set, monthly, accumulated, perRequest, priceInputs, units }`; external token spend stays separate from Cloudflare spend. |
| `nodes` | Known nodes keyed by id with only relevant metrics and units. |
| `diagnostics` | `{ warnings, unsupported, assumptions, limitations }`. |
| `provenance` | Pricing `asOf`, hours/month, sources, dimensions, and per-node verification/model notes. |
| `warnings`, `assumptions`, `unsupported`, `limitations` | Top-level diagnostic aliases for convenient assessment export. |
| `usage`, `monthly`, `modelSpend` | Compatibility billing aliases. |

### Units and allowances

Top-level units identify simulated seconds, USD, USD/s, requests, and USD/month. Each Cloudflare dimension includes a semantic usage unit, billing unit, period, price, currency, source, and verified flag. `cloudflare.allowances` includes every pricing dimension, with used amount, included allowance, overage, exceeded flag, billable amount, cost, and verification state.

### Per-node metrics

| Field | Meaning |
|---|---|
| `lambda`, `out` | Input and forwarded rates in requests/s. |
| `util`, `err` | Utilization/load ratio and modeled error fraction. `util` may exceed 1 for overloaded Queues or Durable Objects; `err` is 0–1. |
| `lat`, `cost` | Service plus Queue wait in seconds and Cloudflare usage in USD/s. |
| `capacity`, `backlog`, `drops` | Queue-only service capacity in requests/s, queued messages, and retention-expiry drops in **messages/s**. |
| `billedRequests`, `doGbS` | Durable Object-only billed requests/s and monthly GB-s. |
| `objects`, `perObjectRate`, `objectLimit`, `overloaded` | Durable Object-only sharding and limit state. |

Irrelevant per-node fields are omitted, not filled with misleading zeroes. Flow follows graph edges with full fan-out; edge `weight` does not affect physics. Ordinary nodes use M/M/c with Erlang-C, caches forward only misses, and only Queue nodes throttle into backlog. See [src/app.js](../src/app.js), [src/engine.js](../src/engine.js), and [src/pricing.js](../src/pricing.js).

### Assumptions and provenance

V1 labels every scenario param as an `editable_model_assumption`, including sourced price defaults, because agents can edit them. Verified platform facts are exposed separately through:

- `provenance.pricing.dimensions`, including verified flags, usage units, allowances, prices, and source links.
- `provenance.nodes[id].verified`, `.verifiedNote`, `.classification`, and `.source` from the catalog.
- `provenance.nodes[id].note` for modeling assumptions and limits.

This separation prevents a sourced product price from being mistaken for a measured workload or capacity result.

## Workflow patterns

### Static site

Model `traffic -> cache -> workers -> r2`. Validate and load once, vary cache hit ratio, Worker latency/CPU, and R2 Class B units with `setParams`, then compare `run({ seconds: 3600 })` snapshots. Use `exportScenario({ assessment: true, provenance: true })` for the review artifact.

### Event-driven Queue

Model `traffic -> workers -> queues -> workers -> r2`. Set Queue concurrency/latency below arrival rate, load with runtime reset, then call `run({ seconds: 120 })`. Inspect `capacity`, `backlog`, `drops`, and `QUEUE_BACKLOG`/`QUEUE_EXPIRY` warnings. `drops` is messages/s, not a message count.

### AI retrieval

Model `traffic -> workers -> ai_gateway -> workers_ai` with a `workers -> vectorize` branch. Native Workers AI contributes Neuron usage to Cloudflare spend. Use `external_model` only for third-party token spend, and populate all four token fields before treating `model.set` as true. Compare `model.monthly`, `model.accumulated`, `model.perRequest`, and `model.priceInputs` separately from `cloudflare.monthly`.

### Persistence and conflict recovery

Call `save()` only when the scenario should replace the shared channel. A successful save returns the server revision and content hash. On `STORAGE_CONFLICT`, reload the stored scenario through the compatibility channel or reload the page, compare it with the candidate, and explicitly choose the merged scenario before saving again. Never retry a stale save blindly.

## Legacy compatibility

### `window.__SIM__`

| Method | Legacy return | Compatibility |
|---|---|---|
| `load(raw)` | `boolean` | Still validates and applies locally. Retains permissive opaque-node behavior for existing callers. |
| `export()` | Scenario object | Same canonical architecture export. |
| `getState()` | State snapshot | Existing top-level fields remain; identity, speed, counters, plan inputs, chaos, and persistence status are additive. |

New agents should use `window.SIM_API` for structured errors, exact advancement, atomic fail-closed behavior, and save status. Existing DOM controls remain wired to the same shared run/reset/speed functions.

### HTTP scenario channel and SSE

[serve.mjs](../serve.mjs) still implements the unversioned loopback channel:

| Endpoint | Behavior |
|---|---|
| `GET /scenario` | Returns stored bytes untouched with `ETag`, `x-scenario-revision`, and `x-scenario-hash`. Missing or invalid JSON returns 500. |
| `POST /scenario` | Requires JSON with a `nodes` array and a body no larger than 1 MB. Validates, preserves stored unknown data, writes atomically, and broadcasts. Optional `If-Match` rejects stale writes with 409. |
| `GET /events` | SSE stream with `{ clientId, scenario, revision, hash, eventId }` after successful POSTs. |

A successful POST returns `{ ok, warning, revision, hash, eventId, scenario }`. Validation failures return 400, stale saves return 409, unsupported content type returns 415, oversized bodies return 413, and write failures return 500. Revision numbers are process-local; the SHA-256 hash and ETag identify stored content across restarts. SSE has no replay, heartbeat, or run-state synchronization.

There is no HTTP v1 endpoint. A full HTTP contract would need page-local simulation state, controls, and request identity that the current stateless scenario channel does not own.

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
- Chaos is limited to predefined scenarios. Exact advancement integrates their simulated-time expiry but is not a general event scheduler.
- There is no rewind or time-travel interface; `reset()` starts a new run identity.
- Static HTML has no persistence; only `serve.mjs` provides the file-backed channel.
- HTTP v1, subscriptions, MCP, and CLI JSON interfaces are not provided.
- The API validates architecture and params, but cannot make modeled prices or capacity into measured production facts.

## References

- [AGENTS.md](../AGENTS.md) — repository change workflow.
- [agent-playbook.md](agent-playbook.md) — executable repository recipes.
- [src/agent-api.js](../src/agent-api.js) — v1 validation, envelopes, snapshot, and factory.
- [src/app.js](../src/app.js) — host wiring, exact clock, controls, persistence, and metrics.
- [src/engine.js](../src/engine.js) — queue, retention, Durable Object, and exact-clock helpers.
- [src/scenario.js](../src/scenario.js) — schema, validation, merge, and hash encoding.
- [src/catalog.js](../src/catalog.js) — node definitions, defaults, bounds, and provenance notes.
- [src/pricing.js](../src/pricing.js) — Cloudflare/model spend separation and pricing provenance.
- [serve.mjs](../serve.mjs) — legacy HTTP, revision/hash, and SSE behavior.
