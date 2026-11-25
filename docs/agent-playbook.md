# Agent playbook

Use this playbook to make a focused change and prove it works. Start with [AGENTS.md](../AGENTS.md) and load [the project skill](../skills/cloudflare-arch-sim/SKILL.md).

## Quick path

```sh
git status --short --branch
npm ci
npm test
npm run build
npm run check:dist
npm run pack:check
npm run test:coverage
```

Keep the branch clean except for intended changes. `check:dist` builds in a temporary directory and leaves `dist/` untouched.

## Command map

| Command | Use it for |
|---|---|
| `npm run dev -- --port 8788` | Local page plus file-backed scenario channel |
| `node cli.mjs --help` | CLI flags and validation rules |
| `node cli.mjs --path` | Absolute path to the bundled HTML |
| `npm test -- tests/engine.test.mjs` | One focused test file |
| `npm run build` | Regenerate the offline bundle |
| `npm run check:dist` | Prove tracked dist matches source |
| `npm run pack:check` | Inspect package contents without publishing |

## Local server smoke test

Start the server in one terminal:

```sh
npm run dev -- --port 8788
```

Run the probes in another:

```sh
curl --fail --silent --show-error http://127.0.0.1:8788/ >/dev/null
curl --fail --silent --show-error http://127.0.0.1:8788/scenario >/dev/null
```

Stop the first terminal with `Ctrl-C`. The default scenario remains [scenario.json](../scenario.json); the server does not rewrite it during these GET requests.

## Change recipes

### Node or catalog

1. Edit the owning definition in [src/catalog.js](../src/catalog.js).
2. If the node exposes a price, change [src/pricing.js](../src/pricing.js) in the same work unit and keep the catalog/pricing parity assertion.
3. Add validation coverage to `tests/scenario.test.mjs` and pricing coverage when relevant.
4. Verify:

```sh
npm test -- tests/scenario.test.mjs tests/pricing.test.mjs
npm test
npm run build
npm run check:dist
```

### Pricing

1. Edit [src/pricing.js](../src/pricing.js), including `asOf` and source links only when supported by evidence.
2. Align catalog price fields and extend `tests/pricing.test.mjs`.
3. Keep non-Cloudflare model spend outside Cloudflare usage, overage, and projections.
4. Verify:

```sh
npm test -- tests/pricing.test.mjs
npm test
npm run build
npm run check:dist
```

### Scenario

1. Edit [scenario.json](../scenario.json); preserve unknown fields, params, and node types.
2. Use [src/scenario.js](../src/scenario.js) for schema, merge, and encoding behavior rather than adding a second validator.
3. Verify:

```sh
npm test -- tests/scenario.test.mjs tests/serve.test.mjs
npm run dev -- --port 8788
curl --fail --silent --show-error http://127.0.0.1:8788/scenario >/dev/null
```

4. Stop the server. Use plain `npm run build` for the live channel; `node build.mjs --scenario scenario.json` intentionally embeds a pinned snapshot.

### Physics

1. Change pure queue behavior in [src/engine.js](../src/engine.js); change graph orchestration in [src/app.js](../src/app.js) only when needed.
2. Preserve the invariants in [AGENTS.md](../AGENTS.md#simulator-invariants); keep formulas in source and assert behavior in tests.
3. Add the smallest regression to `tests/engine.test.mjs`.
4. Verify:

```sh
npm test -- tests/engine.test.mjs
npm test
npm run build
npm run check:dist
```

### UI

1. Change [src/index.html](../src/index.html), [src/styles.css](../src/styles.css), or [src/app.js](../src/app.js) while keeping English copy.
2. Build and start the server, then inspect it in Orca's browser:

```sh
npm run build
npm run dev -- --port 8788
orca tab create --url http://127.0.0.1:8788/ --json
orca snapshot --page <browserPageId> --interactive
orca console --page <browserPageId> --limit 50 --json
orca tab close --page <browserPageId> --json
```

3. Replace `<browserPageId>` with the returned id. Exercise the changed control, take a snapshot after async updates, and confirm the console has no new errors.
4. Close the browser tab and stop the server. Do not substitute a generic browser tool.

### Docs and agent tooling

1. Update [README.md](../README.md), [AGENTS.md](../AGENTS.md), this playbook, or [the skill](../skills/cloudflare-arch-sim/SKILL.md) beside the workflow it explains.
2. Link to implementation files instead of repeating prices, defaults, or physics.
3. Keep README screenshots and human instructions intact.
4. Verify links and whitespace, then run the full quick path when scripts or CI change:

```sh
git diff --check
npm test
npm run check:dist
npm run pack:check
```

## Common failures and recovery

| Symptom | Recovery |
|---|---|
| `npm ci` reports a lockfile mismatch | Restore unintended `package.json`/`package-lock.json` edits; do not regenerate the lockfile casually. |
| `check:dist` reports stale dist | Run `npm run build`, review `git diff -- dist`, then rerun `npm run check:dist`. |
| `EADDRINUSE` on port 8788 | Choose another port with `npm run dev -- --port 8789`. |
| CLI rejects `--port` | Use an integer from 1 through 65535 and provide a value. |
| CLI rejects `--scenario` | Provide a readable JSON file containing an object with a `nodes` array. |
| `/` returns 404 | Run `npm run build`; the server expects `dist/cloudflare-arch-sim.html`. |
| `/scenario` returns 500 | Validate the file with `node -e "JSON.parse(require('fs').readFileSync('scenario.json','utf8'))"`. |
| Server warns that the page embeds a scenario | Rebuild without `--scenario` before testing the live channel. |
| `POST /scenario` rejects an unknown type | GET the stored file, preserve the unknown node/data, and do not introduce a new unknown type. |
| POST reports a node type conflict | Preserve the stored opaque node's extras or choose a new id; do not overwrite incompatible data. |
| `pack:check` omits a runtime file | Update the `files` list in `package.json`, then rerun `npm run pack:check`. |
| Orca reports a stale browser ref | Rerun `orca snapshot --page <browserPageId> --json` and use the new refs. |

## Delivery boundary

Commit on the task branch, push it, and open a PR against `main`. Watch checks and review feedback, but do not merge or publish. npm publication remains manual with 2FA.
