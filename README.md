# cloudflare-arch-sim

A drag-and-drop Cloudflare architecture simulator that renders **inside an Orca chat**.

Dark canvas, drag components from a palette, wire them, run simulated traffic, throw chaos at
it, and watch where it saturates and what it costs per hour. Each node carries a live 0-100% load
bar, a `LOAD` / `SATURATED` / `ERR` badge, and shakes red when it goes over 100%. Request beads
speed up and jitter with load, turn red on a hot edge, and the canvas raises alerts
(`HOT PATH BOTTLENECK`, `ERROR BUDGET BURN`, `DATA LOSS RISK`, `SPOF`). Built as one self-contained HTML
file so Orca can render it with `::orca-visual`.

## Why it exists

Architecture diagrams lie: they show boxes, not bottlenecks. This one carries the real
constraint of each Cloudflare product (concurrency, per-object limits, rows billed, per-store
API throttles) and turns them into queueing behaviour you can see.

It is a **model**, not a load test. The numbers are only as good as the parameters, and every
node says whether it was verified in the docs or is an assumption you can edit.

## Run it

```bash
node build.mjs        # -> dist/cloudflare-arch-sim.html (single file, no deps)
```

Open `dist/cloudflare-arch-sim.html` over http (or drop it in `$ORCA_CHAT_SCRATCH_DIR` and
emit `::orca-visual{file="cloudflare-arch-sim.html"}`).

## Model

- Flow follows the edges. A node passes the same rate to every outgoing edge (calls, not a split).
- Each node is an M/M/c queue: `c` concurrency, `service time`, Erlang-C wait. `util >= 1`
  pins the node at a 30 s wait and paints it red.
- A cache node forwards `1 - hit` downstream.
- Beads cross a link at `min(50, lambda)` per second, where `lambda` is the **sending**
  node's output rate: 1 req/s shows one bead per second, 10 shows ten. A source at 0 req/s
  keeps its edge dim and idle even when the downstream node is hot. The 50 cap is visual only;
  utilization, latency and cost always use the real rate.
- The cost panel follows a plan. **Free** flags the daily limits it exceeds; **Paid $5** adds
  the included Workers, D1, Durable Objects, KV and Queues allowances and bills the overage at
  unit prices; **Custom** uses a base fee plus raw usage against your monthly budget. Prices and
  allowances live in one table in `src/pricing.js`, with `asOf` and source URLs.
- `Requests` counts accepted source traffic since reset, and `Cloudflare $/req` is
  `spent / requests`: usage only, excluding the plan base fee. External model token prices are
  entered on the Model node and shown as separate `Model spend` / `Model $/req` rows; they never
  enter the Cloudflare total, overage, projection or budget bar. Nodes marked non-Cloudflare (the
  Model provider, external APIs) contribute nothing to `Usage`, `Spent` or `Cloudflare $/req`.
- Cost per second is `rate * unitsPerRequest * pricePerMillion`, for Cloudflare nodes only. Workers add
  `rate * cpuMs * $0.02/M CPU-ms`; Durable Objects add
  `rate * latency * 0.128 GB * pricePerGBs`.
- The catalog's default unit prices are compared against `PRICING.dims` by the test suite, so a
  price that drifts between the two tables fails `node --test`.
- Errors appear above 100% utilization (`min(85%, (util - 1) * 0.55)`), and the store 402 chaos
  pins the external node at 100% errors.
- Critical path is the longest chain of node latencies from any source.
- Chaos effects last in real seconds, not simulated ones.

## Verified defaults (checked in docs)

| Component | Constraint | Source |
|---|---|---|
| Workers | 10M req/mo included, then $0.30/M; 30M CPU-ms included, then $0.02/M | workers/platform/pricing |
| Durable Objects | $0.15/M requests, $12.50/M GB-s; ~1,000 req/s soft limit per object | durable-objects/platform/pricing |
| D1 | 25B rows read included then $0.001/M; 50M written then $1.00/M | d1/platform/pricing |
| Tiendanube API | 2 req/s leaky bucket, burst 40, per store + app | tiendanube.github.io/api-documentation |

Everything else (KV, R2, Queues, Vectorize, AI Gateway, Workers AI, Cache, WAF, Turnstile)
is marked **assumption** in the inspector: the field is editable and the node says so.

## Adding a component

All of it lives in `src/catalog.js`: name, group, icon, default params, `verified` text, `doc`
link. Add an entry and it appears in the palette.

## State channel (human and agent edit the same scenario)

`scenario.json` is the source of truth. The page loads it from, in order: a valid `#s=` hash,
an embedded `window.__SCENARIO__`, `GET /scenario` when served over HTTP, then the built-in
template. Missing fields fall back to catalog defaults. Unknown node types, extra fields and
extra params are kept as-is and reported in one line (rendered only when the type exists).
`serve.mjs` merges the stored unknown data back into every write: an omitted opaque node,
unknown field/param, or edge attached to a preserved node comes back, and removing a *known*
node still works. If an incoming node reuses a stored opaque id, the stored node's unknown
fields/params are attached to the incoming one (whose type/identity win); a partial opaque node
whose id is already in the file is completed from storage. A genuinely new unknown type is
rejected with 400, and a type reuse whose extras cannot be attached is rejected with a 400
naming the id and both types. Genuinely unusable content is rejected. Aliases are plain text
(max 80 characters, no control characters) and are escaped at every render. Every catalog param
in `p`, sources included, is clamped to `CATALOG.ranges` (the same table the inspector uses);
preserved unknown params are kept verbatim and are not clamped. Out-of-range catalog values
produce a one-line error and POST rejects them with 400. A legacy source `concurrency: 0` is
normalized to 1 with a one-line note; negatives still fail. Prototype names (`__proto__`,
`constructor`, ...) are rejected outright.

```bash
node serve.mjs                            # page on 127.0.0.1:8787, scenario.json, SSE /events
node serve.mjs --host 0.0.0.0             # open the socket (prints a warning)
node build.mjs --scenario scenario.json   # offline dist with the scenario embedded
```

`serve.mjs` binds loopback by default because anyone who can reach it can rewrite the file.
The `Host` header is pinned to the loopback pairs (`127.0.0.1:<port>`, `localhost:<port>`,
`[::1]:<port>`) on every route, so a DNS-rebinding page cannot use its own domain; an
explicit non-wildcard `--host` is added to the allowlist, but with a wildcard bind browsers
must still use a loopback name. When `Origin` is present it must be `http://` plus an allowed
host, and `Origin: null` is rejected: the channel is only for the page served by `serve.mjs`,
not for a page opened from `file://`. No CORS headers are emitted.

`POST /scenario` requires `content-type: application/json` (415 otherwise), a `nodes` array,
and a valid scenario. It writes atomically, answers 500 with a one-line error if the write
fails (the server stays up), and only broadcasts after a successful write. `GET /scenario`
serves the stored bytes untouched. Every write merges the stored unknown data back in, so an
omission cannot delete an opaque node, an unknown param/field, or an edge attached to a
preserved node; edges and unknown fields of removed *known* nodes are not resurrected.

`window.__SIM__` is the agent API: `load(scenario)`, `export()`, `getState()`. The `Copy JSON`
header button copies `export()`; human edits POST to `/scenario` debounced and the server
broadcasts them over SSE, so both sides converge. A click without moving a node publishes
nothing; only real changes (moved node, new edge, param edit, add/delete) are written.

`getState()` units: `time` is simulated seconds, `spent` and per-node `cost` are USD and USD/s,
`rate` is USD/s (the UI shows `rate * 3600` as $/h), per-node `lat` and `pathLat` are seconds,
`lambda` is req/s, and `util` and `err` are 0..1 fractions.

Build trap: `node build.mjs --scenario scenario.json` overwrites `dist/cloudflare-arch-sim.html`
with a pinned snapshot, and `__SCENARIO__` outranks `GET /scenario`. Run `node build.mjs`
(no flag) before `node serve.mjs` for the live loop, or point `serve.mjs --file` at the
embedded build and accept the pinned snapshot. `serve.mjs` warns when the page it serves
embeds a scenario.

## Known gaps

- The static dist has no persistence on its own: reloading it restarts from the embedded
  scenario (run `serve.mjs` for the live file-backed loop). A plain static server gets one
  `/scenario` probe at load and no SSE connection.
- There is no `Copy link` button yet; `SCENARIO.encode(export())` still builds a `#s=` link
  by hand.
- Fan-out is "calls", not weighted routing; no load balancer split. Edge `weight` is preserved
  in the JSON but physics ignores it so far.
- Cycles are ignored by the topological pass (nodes in a cycle get zero traffic).
- Pricing is request/row based only; storage and egress are not modelled.
- External model token pricing is user-entered and kept outside the Cloudflare total; D1 rows
  written, Vectorize dimensions and R2 operations are not part of the plan overage.
- The plan table has no unverified numbers: every unit price and allowance was checked against
  the live Cloudflare docs on the `asOf` date.
