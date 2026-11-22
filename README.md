# cloudflare-arch-sim

A drag-and-drop Cloudflare architecture simulator that renders **inside an Orca chat**.

Dark canvas, drag components from a palette, wire them, run simulated traffic, throw chaos at
it, and watch where it saturates and what it costs per hour. Each node carries a live 0-100% load
bar, a `LOAD` / `SATURATED` / `ERR` badge, and shakes red when it goes over 100%. Request beads
speed up and jitter with load, turn red on a hot edge, and the canvas raises alerts
(`HOT PATH BOTTLENECK`, `ERROR BUDGET BURN`, `DATA LOSS RISK`, `SPOF`). Each node carries a live 0-100% load
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
- Beads cross a link at `min(50, lambda)` per second: 1 req/s shows one bead per second, 10 shows ten. The 50 cap is visual only; utilization, latency and cost always use the real rate.
- Cost per second is `rate * unitsPerRequest * pricePerMillion`. Workers add
  `rate * cpuMs * $0.02/M CPU-ms`; Durable Objects add
  `rate * latency * 0.128 GB * pricePerGBs`.
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

## Known gaps

- No persistence: the topology resets on reload.
- Fan-out is "calls", not weighted routing; no load balancer split.
- Cycles are ignored by the topological pass (nodes in a cycle get zero traffic).
- Pricing is request/row based only; storage, egress and per-model token prices are not modelled.
