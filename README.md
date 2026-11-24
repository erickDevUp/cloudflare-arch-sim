# cloudflare-arch-sim

A drag-and-drop Cloudflare architecture simulator that renders **inside an Orca chat** as a
single self-contained HTML file. Drop components on the canvas, wire them, send simulated traffic,
throw chaos at the system, and watch where it saturates and what it costs per hour.

![The default scenario: component palette, wired graph, chaos bar and the plan selector in the cost panel](docs/images/overview.png)

*The default "Beauty store on Cloudflare" scenario, running with the Paid $5 plan selected.
Every node shows live load and its own status badge; edges carry animated request beads.*

## What it is — and when to use it

Use it to talk through an architecture: "what happens if the store API slows down?", "does the
cache actually save us money?", "which node is the single point of failure?". It is a **model**,
not a load test and not a Cloudflare emulator. It gives you a shared picture you can edit together
in a chat, or embed as one offline HTML file with no runtime dependencies.

Open `dist/cloudflare-arch-sim.html` in Orca, or copy it into `$ORCA_CHAT_SCRATCH_DIR` and emit
`::orca-visual{file="cloudflare-arch-sim.html"}` to render it in the conversation. The static file
is the whole app: CSS, JavaScript and icons are inlined by `build.mjs`. The live, file-backed
channel described below is an optional addition served by `serve.mjs`.

## Engine model

- **Flow follows the edges.** A source emits `rate` requests/second. Every other node passes its
  **full output rate to every outgoing edge** — one node calling three services sends `lambda` to
  each of them. This is calls, not a weighted split. Edge `weight` is validated, stored and
  exported, but **does not affect the physics yet** (roadmap).
- **Queueing is M/M/c with Erlang-C.** Service time is the node's `latency` in ms
  (`mu = 1000 / latency`), `c` is `concurrency`, and `util = lambda / (mu * c)`. Erlang-C gives
  the wait; `util >= 1` pins the node at a 30 s wait and paints it red. A cache forwards only
  `1 - hit` of its input downstream.
- **Queues throttle, they don't multiply.** A Queue node forwards `min(lambda, concurrency /
  (latency/1000))` requests/s; the excess accumulates as a backlog. Backlog evolves with
  **simulated time** (`backlog = capacity * FIFO wait`, Little's law), not wall-clock time. Messages
  whose wait exceeds `retention` (default 4 days = 345600 s) expire and are counted as drops/s.
  Assumption: strict FIFO and a single deterministic service rate — real Queues use retries and
  variable batch sizes, so this models a smoothed average. Only Queue nodes are throttled; every
  other node keeps the full fan-out semantics.
- **Errors and alerts.** Above full utilization, `err = min(0.85, (util - 1) * 0.55)`; a store 402
  chaos pins the external node at `err = 1`. The canvas raises `HOT PATH BOTTLENECK`,
  `ERROR BUDGET BURN`, `DATA LOSS RISK` and `SPOF` alerts. The reported critical path is the
  longest chain of node latencies from any source.
- **Beads are decoration.** An edge animates `min(50, sender output rate)` beads per second; the
  cap of 50 is **visual only**. Utilization, latency and cost always use the real rate, and a
  source at 0 req/s keeps its edge idle even when the node downstream is hot.
- **Chaos uses real time.** The 429, DO eviction, D1 write storm, cache miss, store 402 and
  webhook buttons set expiry with `performance.now()` in **real seconds** (8–12 s depending on
  the button), independently of the simulation-speed multiplier.
- **Verified vs assumption.** The inspector labels a node `verified in docs` only when
  `src/catalog.js` carries a `verified` note and a source link. Every other number says
  `assumption — edit it`; those fields are editable and keep the simulator honest about what is
  a hard limit and what is a guess.

## Cost model

The cost panel separates Cloudflare spend from model-token spend.

| Row | Meaning |
|---|---|
| `Usage` | Cloudflare spend rate, `$/h` (`rate * 3600`, where `rate` is USD/s across Cloudflare nodes only) |
| `Spent`, `Requests` | Dollars and accepted source requests accumulated since reset |
| `Cloudflare $/req` | `spent / requests`: **usage only, excluding the plan base fee** |
| `Model spend`, `Model $/req` | Token spend from the external model provider, in its own bucket |
| Plan rows | Base fee, overage, projected monthly total and the allowance/budget bar |

Per second, a Cloudflare node costs `lambda * units * price / 1e6` USD. Workers add
`lambda * cpuMs * $0.02/M CPU-ms`; Durable Objects add
`lambda * latency(s) * 0.128 GB * $12.50/M GB-s`. Non-Cloudflare nodes (the Model provider and
the Tiendanube API) never contribute to Cloudflare usage, spent, `$/req`, overage or the budget
bar. Per-second dollars are projected to a month with `3600 * 730` hours.

**Plans:** *Free* has no base fee and flags the daily limits it exceeds; *Paid $5* adds the
included monthly allowances and bills overage at the unit prices below; *Custom* uses a base fee
plus raw usage against your monthly budget, with no included allowances.

**Verified unit prices** (`PRICING.asOf = 2026-11-21`; sources are linked in the panel and kept in
`src/pricing.js`):

| Dimension | Paid plan includes | Overage price | Source |
|---|---|---|---|
| Workers requests | 10M / month | $0.30 / million | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Workers CPU time | 30M CPU-ms / month | $0.02 / million CPU-ms | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| D1 rows read | 25B / month | $0.001 / million | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| Durable Objects requests | 1M / month | $0.15 / million | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Durable Objects duration | 400k GB-s / month | $12.50 / million GB-s | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Workers KV reads | 10M / month | $0.50 / million | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Queues operations | 1M / month | $0.40 / million | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |

The free-plan daily limits applied by the simulator come from the same pages: 100k Workers
requests/day and 10 ms CPU per invocation, 5M D1 rows read/day, 100k DO requests/day and 13k
DO GB-s/day, 100k KV reads/day, and 10k queue operations/day. No other limits are asserted.

Model token spend is computed only when all four fields on the Model node are filled:
`((inTokens * inPrice) + (outTokens * outPrice)) / 1e6` dollars per request, multiplied by the
node's request rate. It stays `unset` until then and is never folded into the Cloudflare total,
overage, projection or budget bar. The test suite cross-checks every catalog price against
`PRICING.dims`, so the two tables cannot drift silently.

![Custom plan: base fee, monthly budget bar, and model token spend in its own row](docs/images/cost-panel.png)

*The Custom plan with a $10 base fee and a $5,000 budget. The model row shows a separately
computed token bill; it never enters the Cloudflare total above it.*

## Install and run

There is **no published npm package and no `npx` command** for this project. `package.json` only
provides `npm test` and a build-time icon dependency (`lucide-static`); run the tools from a
checkout with Node 18 or newer:

```bash
npm install              # one-time: build-time icons only, no runtime dependencies
node build.mjs           # -> dist/cloudflare-arch-sim.html (single offline file)
# open dist/cloudflare-arch-sim.html in Orca, or use ::orca-visual in a chat

node serve.mjs --port 8788            # page + shared scenario channel on 127.0.0.1:8788
node build.mjs --scenario scenario.json   # offline build with scenario.json embedded
node --test                            # 46 tests: pricing, scenario schema, HTTP channel
```

`node serve.mjs --port 8788` serves the page at `http://127.0.0.1:8788/`, the live `scenario.json`
at `/scenario`, and an SSE stream at `/events`. Build trap: `node build.mjs --scenario` embeds a
**pinned** scenario that outranks `GET /scenario`. Rebuild with plain `node build.mjs` before
starting the shared channel, or point `serve.mjs --file` at the pinned build and accept that it is
a snapshot. The server warns when the page it serves embeds a scenario.

## State channel — humans and agents edit the same scenario

`scenario.json` is the source of truth for the shared channel. The page loads, in order: a valid
`#s=` hash, an embedded `window.__SCENARIO__`, `GET /scenario` over HTTP, then the built-in
template. Missing fields fall back to catalog defaults.

![Copy JSON exports the current scenario; an agent-loaded name and rate are already on the graph](docs/images/state-channel.png)

*The `Copy JSON` button exports the current scenario. Here an agent has also called
`window.__SIM__.load()` to rename the source and raise its rate before exporting it again.*

**Schema:** a root object with `version` (1), `name`, `nodes` and `edges`. A node has `id`,
`type`, `x`, `y`, an optional `alias` and a `p` object of parameters; an edge has `from`, `to`
and an optional non-negative `weight`. Unknown root/node/edge fields, unknown params and unknown
node types are kept verbatim, so an edit cannot silently delete data the app does not understand.
Unknown types are preserved but not rendered, and cannot be *introduced* through POST.

**Agent API:** `window.__SIM__ = { load, export, getState }`.

- `load(scenario)` validates and applies a scenario, then fits the view; returns `true` or
  `false`.
- `export()` returns the current scenario object (the same JSON `Copy JSON` writes).
- `getState()` returns `{ time, spent, rate, pathLat, running, nodes }`. `time` is simulated
  seconds, `spent` is USD, `rate` is USD/s (the UI shows `rate * 3600` as `$/h`), `pathLat` and
  per-node `lat` are seconds, per-node `cost` is USD/s, `lambda` is req/s, and `util`/`err` are
  0..1 fractions.

```js
// In the page console — read, change, preview, then let the UI publish it:
const s = window.__SIM__.export();
s.nodes.find(n => n.type === 'traffic').p.rate = 25;
window.__SIM__.load(s);
window.__SIM__.getState().nodes;   // live util / err / lat / cost per node

// Build a shareable #s= link by hand (there is no Copy link button yet):
const hash = '#s=' + window.SCENARIO.encode(s); // null if over 8000 chars
```

From a terminal, round-trip the stored file rather than posting a partial object — omitted known
nodes are treated as deletions:

```bash
curl -s http://127.0.0.1:8788/scenario -o scenario.json   # GET serves the stored bytes
# ...edit scenario.json...
curl -s -X POST http://127.0.0.1:8788/scenario \
  -H 'content-type: application/json' \
  --data-binary @scenario.json
```

**Writes and updates:** human edits (a real drag, a new edge, a parameter edit, add/delete) POST
to `/scenario` debounced by 400 ms; a click that does not move a node publishes nothing. A
successful atomic write broadcasts the scenario over `/events` with a `clientId`, so other tabs
converge without echoing the writer's own change. `POST /scenario` requires
`content-type: application/json` and a `nodes` array; invalid content gets a 400/415, a failing
write gets a 500, and broadcasting happens only after the write succeeds.

**Lossless round-trip:** every write merges stored unknown data back in. An omitted opaque node,
an unknown field or param, and an edge attached to a preserved node all come back; removing a
*known* node still works. Reusing a stored opaque node's id attaches its unknown data to the
incoming node (the incoming type wins), and a partial opaque node is completed from storage.
Introducing a genuinely new unknown type is rejected with a 400; so is a type reuse whose extras
cannot be preserved, which names the id and both types. Catalog params are clamped to `CATALOG.ranges`
(the same table the inspector uses) and out-of-range values are rejected; unknown params are kept
verbatim. Aliases are limited to 80 characters without control characters and are escaped at
every render; prototype names (`__proto__`, `constructor`, ...) are rejected.

**Localhost-only, not authenticated.** `serve.mjs` binds loopback by default and pins the `Host`
header to the loopback pairs for its port (`127.0.0.1`, `localhost`, `[::1]`). An explicit
non-wildcard `--host` is added to the allowlist, but a wildcard bind still requires a loopback
name in the browser. If `Origin` is present it must be `http://` plus an allowed host; `Origin:
null` (a `file://` page) is rejected, and no CORS headers are emitted. Anyone who can reach the
port can rewrite the file — there is no login or token. Keep it on loopback.

## Architecture map

| File | Role |
|---|---|
| `src/index.html`, `src/styles.css` | Page layout (palette, canvas, inspector, cost panel) and dark theme |
| `src/catalog.js` | Component types, editable ranges, defaults, verified notes and doc links |
| `src/pricing.js` | Plans, verified pricing dimensions, `asOf`/sources, monthly math, model bucket |
| `src/scenario.js` | Pure schema shared by page, server and tests: validate, merge, `#s=` encode/decode, layout |
| `src/app.js` | Queueing engine, rendering, chaos, UI events, `window.__SIM__` and the channel client |
| `serve.mjs` | Local page, JSON endpoint, SSE broadcast, atomic writes and Host/Origin checks |
| `build.mjs` | Inlines CSS/JS/icons into `dist/cloudflare-arch-sim.html`; optional `--scenario` snapshot |
| `scenario.json` | Live source of truth when served by `serve.mjs` |
| `tests/` | `pricing`, `scenario` and `serve` test files (`node --test`) |
| `docs/images/` | Screenshots used in this README; `dist/` is generated, not hand-edited |

## Verification and known gaps

`node --test` passes all 46 tests on this branch (pricing math, catalog/price parity, schema
validation, merge rules and the HTTP channel). Prices are the values in `PRICING.dims` with
`asOf: 2026-11-21`; adding a component or a price means updating `src/catalog.js` and
`src/pricing.js` together. This README change is documentation only — no source behavior was
modified.

- The static HTML has no persistence of its own: reloading restarts from the embedded scenario
  (or the built-in template). Only `serve.mjs` provides the file-backed, SSE-driven loop; a plain
  static server gets one `/scenario` probe and no subscriptions.
- There is no `Copy link` button; `window.SCENARIO.encode(export())` builds a `#s=` link by hand.
- Fan-out is calls, not weighted routing: edge `weight` is stored and exported but ignored by
  physics. Cycles are skipped by the topological pass, so nodes in a cycle get zero traffic.
- Storage and egress are not modelled. D1 rows written, Vectorize dimensions and R2 operations
  are documented prices but are not part of the plan overage.
- The channel is localhost-only by Host/Origin checks, not authenticated; do not expose the port
  to an untrusted network.
