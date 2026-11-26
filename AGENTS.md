# AGENTS

## Start here

Read [docs/agent-playbook.md](docs/agent-playbook.md) for executable workflows and load the project skill at [skills/cloudflare-arch-sim/SKILL.md](skills/cloudflare-arch-sim/SKILL.md) before changing this repository. When using the simulator as a design tool, read [docs/agent-operator.md](docs/agent-operator.md) for browser `SIM_API` or [docs/mcp.md](docs/mcp.md) for MCP stdio.

## Project map

| Path | Role |
|---|---|
| `src/index.html` | Page structure and script/style entry points |
| `src/styles.css` | Layout, dark theme, and responsive presentation |
| `src/app.js` | Simulation loop, rendering, chaos, state channel client, `window.SIM_API` host, and `window.__SIM__` |
| `src/agent-api.js` | Versioned browser API, pure validation/result helpers, provenance, and structured errors |
| `src/headless-service.js` | Deterministic in-memory simulator host using the existing API, engine, catalog, scenario, and pricing modules |
| `mcp-server.mjs` | Local MCP stdio adapter, explicit tool schemas, resources, prompt, and bin entry |
| `src/engine.js` | Pure queue capacity, forwarding, backlog, and retention helpers |
| `src/state-core.mjs` | Pure identity, persistence-status, and runtime snapshot helpers shared by UI, API, and headless hosts; build generates the Node 18 CommonJS companion `src/state-core.cjs` |
| `src/catalog.js` | Node types, defaults, editable ranges, verified notes, and source links |
| `src/pricing.js` | Source of truth for plans, prices, `asOf`, sources, and spend math |
| `src/scenario.js` | Scenario validation, lossless merge, layout, and `#s=` encoding |
| `scenario.json` | Source of truth for the default live scenario |
| `serve.mjs` | Loopback HTTP page, `/scenario`, `/events`, and atomic scenario writes |
| `cli.mjs` | npm `bin` wrapper and agent-facing flag validation |
| `build.mjs` | Inlines CSS, JavaScript, and icons into one offline HTML file |
| `dist/cloudflare-arch-sim.html` | Generated package payload; never hand-edit |
| `tests/` | Node built-in tests for engine, pricing, scenario, server, CLI, browser/headless APIs, and MCP stdio |
| `docs/agent-operator.md` | Stable `window.SIM_API` v1 contract plus legacy HTTP/SSE operator behavior |
| `docs/mcp.md` | MCP stdio configuration, tool/resource/prompt contract, examples, and v1 boundary |
| `docs/images/` | README screenshots |

## Entry points

- `npm run dev` starts `cli.mjs`, which serves the bundled page and state channel on loopback.
- `node cli.mjs --path` prints the bundled HTML path; `node cli.mjs --help` prints CLI usage.
- `node serve.mjs` runs the same server directly; tests use its exported `startServer`.
- `window.SIM_API` exposes the version 1 capabilities/validate/load/set/plan/billing/run/state/export/save contract with structured results and exact simulated-time advancement.
- `npm run mcp` starts `mcp-server.mjs` over local stdio; `cloudflare-arch-sim-mcp` is the package bin entry.
- `window.__SIM__` preserves the legacy `load`, `export`, and `getState` shapes for browser automation.
- `npm run build` regenerates `dist/cloudflare-arch-sim.html`.

## Simulator invariants

- Flow follows graph edges. Each node sends its full output rate to every outgoing edge; edge `weight` is stored but does not affect physics.
- Ordinary nodes use M/M/c with Erlang-C: `mu = 1000 / latency`, `util = lambda / (mu * concurrency)`, and saturation pins wait at 30 seconds.
- A cache forwards only `1 - hit` of its input downstream.
- Only Queue nodes throttle output to service capacity. Excess traffic becomes backlog, advanced by simulated time; FIFO retention expiry becomes drops/s.
- Cloudflare usage, spend, overage, and projections exclude non-Cloudflare nodes. Model-token spend stays in a separate bucket.
- `src/pricing.js` is the only pricing source of truth. Keep catalog price fields aligned with its dimensions.
- `scenario.json` is the default scenario source of truth. Preserve unknown fields, params, and node types during edits.
- `window.SIM_API` v1 fails closed on unsupported schema versions/nodes/params, returns structured results, uses exact simulated time for assessments, and never duplicates billing or engine math.
- MCP v1 is an adapter over the same semantics. It is local stdio only, reserves stdout for protocol frames, sends diagnostics to stderr, and has no filesystem save, merge, network listener, or remote transport.
- Scenario persistence is revisioned and atomic: v1 `save()` returns revision/hash only after 2xx, uses `If-Match`, and clears dirty only when the saved snapshot is still current.
- `dist/` is generated. Commit it with source changes; CI validates freshness against a clean temporary build.
- UI language is English. UI localization/copy work belongs to Phase 2 after P0.

## Commands

| Command | Purpose |
|---|---|
| `npm ci` | Install exact lockfile dependencies |
| `npm run dev -- --port 8788` | Start the local page and state channel |
| `npm run mcp` | Start the local MCP stdio server |
| `npm run build` | Regenerate the tracked offline bundle |
| `npm test` | Run all Node tests |
| `npm run test:coverage` | Run tests with Node experimental coverage |
| `npm run check:dist` | Compare tracked dist with a fresh temporary build |
| `npm run pack:check` | Inspect the npm package with a dry run |

## Verification loop

1. Confirm the current branch is not `main` and inspect `git status`.
2. Run the focused tests for the changed area; for MCP work include `tests/headless-service.test.mjs` and `tests/mcp-server.test.mjs`.
3. Run `npm test`.
4. Run `npm run build`, review the generated diff, then run `npm run check:dist`.
5. Run `npm run pack:check` and `npm run test:coverage`.
6. Smoke-test `npm run dev -- --port 8788` with `curl` against `/` and `/scenario`, then stop it.
7. For MCP changes, run `node mcp-server.mjs` and the packed bin entry; confirm stdout has no non-protocol output. The SDK client test is the main protocol proof.
8. For UI changes, inspect the page in Orca's browser and check its console.
9. Run `git diff --check` and review the final diff before committing.

## Change recipes

### Node or catalog

1. Change the type, defaults, ranges, or verified notes in `src/catalog.js`.
2. If the node has a price field, update `src/pricing.js` in the same change and keep the parity test green.
3. Add scenario validation coverage in `tests/scenario.test.mjs` and pricing parity coverage when relevant.
4. Run `npm test`, `npm run build`, and `npm run check:dist`.

### Pricing

1. Change `src/pricing.js`; update `asOf` and source links only with verified evidence.
2. Align affected catalog fields and extend `tests/pricing.test.mjs`.
3. Preserve the separation between Cloudflare spend and model-token spend.
4. Run `npm test`, `npm run build`, and `npm run check:dist`.

### Scenario

1. Edit `scenario.json`, not a generated or embedded snapshot.
2. Preserve unknown data and keep node ids and edge endpoints stable unless the task requires a structural change.
3. Run `npm test -- tests/scenario.test.mjs tests/serve.test.mjs`.
4. Use a plain `npm run build` for the live channel; `build.mjs --scenario` creates a pinned offline snapshot.

### Physics

1. Keep pure queue helpers in `src/engine.js`; change orchestration in `src/app.js` only when required.
2. Preserve M/M/c, cache forwarding, full fan-out, simulated-time backlog, and retention semantics.
3. Extend `tests/engine.test.mjs` with the smallest regression case.
4. Run `npm test`, `npm run build`, and `npm run check:dist`.

### Agent API

1. Keep pure validation, result envelopes, request IDs, and provenance in [src/agent-api.js](src/agent-api.js); inject host functions for Node tests.
2. Wire `src/app.js` to existing compute, queue, Durable Object, pricing, and control functions. Do not duplicate engine or billing logic.
3. Preserve `window.__SIM__` return shapes and keep HTTP `/scenario`/SSE unversioned unless a separate task adds HTTP v1.
4. Extend `tests/agent-api.test.mjs` for contract, error, atomicity, provenance, save conflicts, deterministic advancement, and compatibility behavior.
5. Run `npm test`, `npm run build`, and `npm run check:dist`; exercise static site, Queue, AI retrieval, validation, reset, and save workflows in Orca's browser using only `window.SIM_API`.

### MCP

1. Keep [mcp-server.mjs](mcp-server.mjs) as a thin stdio adapter over [src/headless-service.js](src/headless-service.js) and [src/agent-api.js](src/agent-api.js). Do not duplicate engine or billing logic.
2. Preserve explicit strict schemas, structured `isError` envelopes with paths, deterministic request IDs, stdout protocol purity, and the local-only no-save boundary.
3. Extend `tests/headless-service.test.mjs` and `tests/mcp-server.test.mjs`; keep the SDK client integration test as protocol proof.
4. Run `npm test`, `npm run build`, `npm run check:dist`, `npm run pack:check`, and the direct/bin stdio smoke checks.

### UI

1. Treat `src/index.html`, `src/styles.css`, and `src/app.js` as the presentation layer; keep English copy.
2. Run `npm run build` and the state-channel smoke test.
3. Use Orca's browser, not a generic browser tool, for visual and console checks:

```sh
npm run dev -- --port 8788
orca tab create --url http://127.0.0.1:8788/ --json
orca snapshot --page <browserPageId> --interactive
orca console --page <browserPageId> --limit 50 --json
orca tab close --page <browserPageId> --json
```

4. Replace `<browserPageId>` with the id returned by `tab create`; close the tab and stop the server when finished.

### Docs and agent tooling

1. Update `README.md`, this file, the playbook, the operator guide, or the project skill next to the behavior they explain.
2. Link to source files instead of copying prices, formulas, or scenario defaults into prose.
3. Keep README screenshots and human instructions intact.
4. Run `git diff --check`; run the full verification loop when commands or automation change.

## Delivery rules

- Keep all work on a task branch; never switch to or edit the main checkout.
- Do not merge, publish, deploy, or change accounts. npm publication remains manual with 2FA.
- Stage only intended files, keep tests with their behavior, and use a Conventional Commit message.
