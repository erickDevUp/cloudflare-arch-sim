# Agent operator guide

Use this guide when an agent uses the simulator to design or evaluate an architecture rather than change its code. The browser API, HTTP channel, and controls are **experimental and unversioned**; verify them against the linked source before relying on them.

## Quick path

1. Build and start the live channel:

```sh
npm ci
npm run build
npm run dev -- --port 8788
```

2. Open `http://127.0.0.1:8788/` in Orca's browser.
3. Load a validated scenario with `window.__SIM__.load()` or persist one through `POST /scenario`.
4. Start, pause, reset, and set speed through the existing DOM controls; they are not `window.__SIM__` methods.
5. Inspect `window.__SIM__.getState()`, then export with `window.__SIM__.export()`.
6. Record assumptions, pricing provenance, simulated time, and limitations with the result.

For repository changes, use [AGENTS.md](../AGENTS.md) and [the agent playbook](agent-playbook.md) instead.

## Scenario schema and validation

The current schema version is `1`. The authoritative implementation is [src/scenario.js](../src/scenario.js); defaults and editable bounds come from [src/catalog.js](../src/catalog.js).

| Field | Current behavior |
|---|---|
| `version` | Missing or unsupported versions normalize to `1` with a warning. |
| `name` | Optional non-empty string; otherwise `Untitled scenario`. |
| `nodes` | Array of node objects. HTTP POST requires it; browser validation treats a missing array as empty. |
| `edges` | Array of `{ from, to, weight? }`; both endpoints must identify nodes in the scenario. |
| Unknown root fields | Preserved in validation, export, merge, and storage. |

A node has `id`, `type`, optional finite `x`/`y`, optional `alias`, and optional `p` parameters. Missing positions receive a deterministic layout. Missing ids are generated; duplicate ids count as dropped data. Aliases are limited to 80 characters without control characters. Known nodes receive catalog defaults, numeric params are range-checked, and unknown params are preserved. Prototype names such as `constructor` and `__proto__` are rejected.

Unknown node types are preserved as opaque data but are not rendered or simulated. A scenario containing only opaque nodes is rejected by `window.__SIM__.load()`. HTTP POST can preserve opaque nodes already in storage but cannot introduce a new unknown type. Edges touching opaque nodes are exported but ignored by the physics pass.

Legacy `workers_ai` nodes carrying external `inPrice` or `outPrice` fields migrate to `external_model` during validation. Native `workers_ai` nodes keep their id and feed Cloudflare Neuron usage; `external_model` remains a separate non-Cloudflare token-spend bucket.

`window.SCENARIO.validate(raw, window.CATALOG)` currently returns `{ scenario, error, dropped }`. `window.__SIM__.load()` and HTTP POST reject `dropped > 0`; warning-only results can be accepted. Errors are human-readable strings, not structured codes.

Minimal shape:

```json
{
  "version": 1,
  "name": "Agent candidate",
  "nodes": [
    { "id": "source", "type": "traffic", "x": 20, "y": 20, "p": { "rate": 10 } },
    { "id": "api", "type": "workers", "x": 220, "y": 20 }
  ],
  "edges": [{ "from": "source", "to": "api" }]
}
```

## Browser contract

### `window.__SIM__`

| Method | Returns | Current behavior and limits |
|---|---|---|
| `load(raw)` | `boolean` | Validates and applies locally, then fits the view. Resets backlog/drops but does not reset time, spend, running state, speed, plan, budget, or chaos. Does not POST to the server. Failures surface as a toast and `false`, without a structured error. |
| `export()` | Scenario object | Returns normalized current scenario data, including preserved unknown fields and opaque nodes. Does not persist or POST. Runtime metrics, plan, budget, and model spend are not included. |
| `getState()` | State snapshot | Returns the fields described below. It does not mutate the simulation. |

There are currently no `start`, `pause`, `reset`, `setSpeed`, `post`, or `subscribe` methods on `window.__SIM__`.

### Existing controls

| Selector | Effect |
|---|---|
| `#start` | Toggles running; label changes between `Start simulation` and `Pause simulation`. |
| `#reset` | Resets simulated time, Cloudflare spend, request count, internal model spend, chaos, backlog, and drops. Keeps architecture and does not change running state or speed. |
| `#speed` | Number input for simulated seconds per real second, clamped to 1–7200. |
| `.chaos-btn` | Applies temporary chaos using real time, not simulated time. |

Use Orca's browser snapshot and refs to operate these controls. Treat selectors and labels as implementation details, not a stable automation API.

### Boot order

The page tries a valid `#s=` hash, then embedded `window.__SCENARIO__`, then `GET /scenario`, then its built-in template. A plain `npm run build` keeps the live channel authoritative. `node build.mjs --scenario scenario.json` embeds a pinned snapshot that outranks `GET /scenario`.

`window.SCENARIO.encode(scenario)` creates a `#s=` payload and returns `null` above the current 8,000-character limit. This is a share-link helper, not persistence.

## HTTP scenario channel and SSE

[serve.mjs](../serve.mjs) implements the loopback channel.

| Endpoint | Behavior |
|---|---|
| `GET /scenario` | Returns stored bytes untouched. Missing or invalid JSON returns 500. Schema problems are logged as warnings but do not replace the stored response. |
| `POST /scenario` | Requires `application/json`, a JSON object with a `nodes` array, and a body no larger than 1 MB. Validates, rejects dropped data/new unknown types/conflicts, merges stored unknown data, writes atomically, then broadcasts. |
| `GET /events` | SSE stream. Sends an initial comment, then a `data` event after each successful POST. |

A successful POST returns `{ "ok": true, "warning": ... }`. Validation failures return 400, unsupported content type returns 415, oversized bodies return 413, and write failures return 500. Omitted known nodes are deletions; omitted unknown data is restored from storage. Round-trip the full stored scenario before editing.

SSE payloads contain `{ clientId, scenario }`, not simulation metrics or run state. The browser ignores events whose `clientId` matches its own random id. There is no event replay, event id, heartbeat, or run-state synchronization; reconnecting clients should bootstrap with `GET /scenario`.

The server pins allowed loopback `Host` values and rejects foreign or `null` origins. It is not authenticated. Do not expose it to an untrusted network.

Read, edit, and persist a candidate:

```sh
curl --fail --silent --show-error http://127.0.0.1:8788/scenario -o candidate.json
curl --fail --silent --show-error -X POST http://127.0.0.1:8788/scenario \
  -H 'content-type: application/json' \
  --header 'x-client-id: agent-candidate-1' \
  --data-binary @candidate.json
```

## Operate a scenario

### Load without persisting

Run in the page console or an approved browser-evaluation context:

```js
const response = await fetch('/scenario');
const scenario = await response.json();
scenario.name = 'Agent candidate';
const accepted = window.__SIM__.load(scenario);
```

Use `false` as rejection. Because `load()` does not reset runtime counters or persist, call the existing Reset control before a measured run and use HTTP POST when the candidate must become shared state.

### Run and inspect

Use Orca's browser to activate `#start`, wait for simulated time to advance, and read:

```js
const state = window.__SIM__.getState();
const queues = Object.entries(state.nodes).filter(([, node]) => node.type === 'queues');
```

Pause before comparing snapshots. The loop uses `requestAnimationFrame` and wall-clock deltas, so equal wall-clock waits do not guarantee equal simulated time. Chaos expiries also use `performance.now()`.

### Export

```js
const scenario = window.__SIM__.export();
const json = JSON.stringify(scenario, null, 2);
const hashPayload = window.SCENARIO.encode(scenario);
```

Export captures architecture only. Persist with `POST /scenario` when other tabs or future runs must receive it.

## Interpret state and spend

### Top-level state

| Field | Meaning |
|---|---|
| `time` | Simulated seconds since the last reset or page load. |
| `running` | Whether the simulation loop is advancing state. |
| `rate` | Cloudflare usage rate in USD/s; excludes plan base fees and non-Cloudflare nodes. |
| `spent` | Accumulated Cloudflare usage in USD; excludes plan base fees and model/external spend. |
| `pathLat` | Longest active source-to-node latency chain in seconds. |
| `plan` | Current `free`, `paid`, or `custom` plan selection. |
| `usage` | Current modeled monthly Cloudflare totals by pricing dimension. |
| `monthly` | Current plan result: base, overage, total, lines, exceeded limits, and unverified dimensions. |
| `modelSpend` | Current external-model monthly projection as `{ set, total }`; not accumulated spend. |
| `nodes` | Object keyed by known node id; opaque nodes are omitted. |

### Per-node state

| Field | Meaning |
|---|---|
| `lambda` | Input request rate in requests/s. |
| `out` | Forwarded request rate in requests/s after cache/queue behavior. |
| `util` | Utilization fraction; `1` is saturation, not 100%. |
| `err` | Error fraction from 0 to 1; derived from overload or the external 402 chaos state. It is not an error code. |
| `lat` | Service plus modeled queue wait in seconds. |
| `cost` | Cloudflare usage in USD/s; zero for non-Cloudflare nodes. |
| `capacity` | Queue service capacity in requests/s; zero for non-Queue nodes. |
| `backlog` | Queued messages, advanced with simulated time. |
| `drops` | Retention-expiry drops in messages/s, not a cumulative count. |
| `billedRequests` | Durable Object billed requests/s after transport and WebSocket message rules. |
| `doGbS` | Durable Object monthly GB-s under the current active-duration model. |
| `objects` | Durable Object count used for explicit sharding. |
| `perObjectRate` | Durable Object arrivals/s divided by object count. |
| `objectLimit` | Documented per-object soft request-rate limit used by the model. |
| `overloaded` | Whether the Durable Object reaches its modeled service or per-object limit. |

Flow follows edges with full fan-out; edge `weight` does not affect physics. Ordinary nodes use M/M/c with Erlang-C, caches forward only the miss fraction, and only Queue nodes throttle into backlog. See [src/app.js](../src/app.js) and [src/engine.js](../src/engine.js) for the model.

### Cloudflare, model, and external spend

Cloudflare usage, accumulation, overage, and projections exclude nodes marked `cloudflare: false`. Native `workers_ai` inference contributes Neuron usage to Cloudflare spend. External-model token spend is a separate bucket and remains unset until all four token fields are populated; `getState().modelSpend` exposes its current monthly projection, while accumulated model spend remains internal. The UI shows the projection in `#k-model` and accumulated per-request model spend in `#k-modelreq`.

The external API node is non-Cloudflare and has no separate external-spend bucket; its reported cost is zero. Prices, plan math, `asOf`, and source links live only in [src/pricing.js](../src/pricing.js).

## Assumptions, provenance, and known limitations

- This is a rate model, not a load test or Cloudflare emulator. It does not model retries, variable batch sizes, distributed coordination, storage/egress, or real provider capacity.
- Catalog `verified` notes and source links identify sourced claims; other values are editable assumptions. Record which inputs were assumptions.
- Cycles are skipped by the topological pass, so nodes in a cycle receive zero traffic.
- Durable Object arrivals are assumed evenly sharded; active duration is capped per object and does not model individual connection schedules or pending I/O.
- `load()` changes architecture without resetting runtime counters; Reset keeps the architecture and running state.
- Base-fee/budget inputs, speed, chaos, accumulated model spend, request count, and CPU rate are absent from `getState()` and scenario export.
- SSE synchronizes scenarios only. It does not synchronize run state, metrics, spend, or control changes.
- Static HTML has no persistence; only `serve.mjs` provides the file-backed channel.
- Unknown nodes are preserved but not fail-closed: they can be omitted from simulation while remaining in exported/stored data, and they are absent from `getState().nodes`.

## Stabilization required after P0

The current interface must not be described as stable. Before external agents depend on it, complete:

1. A versioned machine-facing API with explicit compatibility rules.
2. Structured error codes alongside human-readable messages.
3. Deterministic set/run/state/export operations, including reset and time control.
4. Assumptions and provenance embedded in output.
5. Fail-closed behavior for unsupported nodes and params.
6. Possibly an MCP or CLI JSON interface for external agents.

## References

- [AGENTS.md](../AGENTS.md) — repository change workflow.
- [agent-playbook.md](agent-playbook.md) — executable repository recipes.
- [src/scenario.js](../src/scenario.js) — schema, validation, merge, and hash encoding.
- [src/catalog.js](../src/catalog.js) — node definitions, defaults, bounds, and provenance notes.
- [src/app.js](../src/app.js) — browser API, controls, simulation loop, and metrics.
- [src/engine.js](../src/engine.js) — queue capacity, backlog, and retention helpers.
- [src/pricing.js](../src/pricing.js) — Cloudflare/model spend separation and pricing provenance.
- [serve.mjs](../serve.mjs) — HTTP and SSE behavior.
