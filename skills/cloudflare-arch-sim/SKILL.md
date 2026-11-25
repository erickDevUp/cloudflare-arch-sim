---
name: cloudflare-arch-sim
description: "Trigger: cloudflare-arch-sim, simulator change, pricing, scenario, queue physics. Operate and verify this repo safely."
license: ISC
metadata:
  author: "erickDevUp"
  version: "1.0"
---

## Activation Contract

Load this skill for any change to the simulator, its packaging, agent tooling, or documentation. Read `AGENTS.md` and `docs/agent-playbook.md` before editing.

## Hard Rules

- Treat `src/pricing.js` as the pricing source of truth and `scenario.json` as the default scenario source of truth.
- Preserve M/M/c, full fan-out, cache forwarding, simulated-time queue backlog, retention drops, and separate Cloudflare/model spend.
- Never hand-edit `dist/`; rebuild it and keep it fresh.
- Preserve unknown scenario data and lossless merge behavior.
- Keep UI work in English and defer localization/copy changes to Phase 2 after P0.
- Use Orca's browser for UI checks.
- Work on a task branch; do not merge, publish, deploy, or change accounts.

## Decision Gates

| Change | Primary files | Required checks |
|---|---|---|
| Node/catalog | `src/catalog.js`, pricing if applicable | Scenario/pricing tests, build, dist check |
| Pricing | `src/pricing.js`, `src/catalog.js` | Pricing tests, build, dist check |
| Scenario | `scenario.json` | Scenario/server tests |
| Physics | `src/engine.js`, `src/app.js` | Engine tests, full tests, build |
| UI | `src/index.html`, `src/styles.css`, `src/app.js` | Build, smoke test, Orca browser |
| Docs/tooling | `AGENTS.md`, playbook, skill, scripts, CI | Relevant tests, full verification |

## Execution Steps

1. Inspect the branch, working tree, source of truth, and existing tests.
2. Make the smallest change in the owning module; add a focused regression test for behavior changes.
3. Run focused tests, then `npm test`.
4. Run `npm run build` and `npm run check:dist` for app-source changes.
5. Run `npm run pack:check`, `npm run test:coverage`, and the local server smoke test.
6. Use Orca browser snapshots and console output for UI changes.
7. Review the diff, commit on the task branch, and report exact evidence without merging or publishing.

## Output Contract

Return changed files, commands and results, generated-dist status, skill metadata, CI/PR status when applicable, and any limitation or skipped check.

## References

- `../../AGENTS.md`
- `../../docs/agent-playbook.md`
- `../../src/pricing.js`
- `../../src/engine.js`
- `../../src/app.js`
- `../../scenario.json`
