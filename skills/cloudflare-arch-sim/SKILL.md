---
name: cloudflare-arch-sim
description: "Trigger: cloudflare-arch-sim, simulator change, architecture design, pricing, scenario, queue physics. Edit the repo or operate SIM_API v1 safely."
license: ISC
metadata:
  author: "erickDevUp"
  version: "1.0"
---

## Activation Contract

Load this skill for repository changes or for using the simulator to design/evaluate an architecture. For operator work, read `docs/agent-operator.md`; for repository work, read `AGENTS.md` and `docs/agent-playbook.md` before editing.

## Hard Rules

- Treat `src/pricing.js` as the pricing source of truth and `scenario.json` as the default scenario source of truth.
- Preserve M/M/c, full fan-out, cache forwarding, simulated-time queue backlog, retention drops, and separate Cloudflare/model spend.
- Never hand-edit `dist/`; rebuild it and keep it fresh.
- Preserve unknown scenario data and lossless merge behavior.
- Keep UI work in English and defer localization/copy changes to Phase 2 after P0.
- Use Orca's browser for UI checks.
- Treat `window.SIM_API` v1 as the stable browser agent contract; treat `window.__SIM__`, HTTP/SSE, and DOM controls as compatibility surfaces.
- Work on a task branch; do not merge, publish, deploy, or change accounts.

## Decision Gates

| Goal | Authority | Required checks |
|---|---|---|
| Change the simulator codebase | `AGENTS.md` and `docs/agent-playbook.md`; owning source/tests | Focused/full tests; build, dist, pack, coverage, and smoke checks as applicable |
| Design/evaluate an architecture | `docs/agent-operator.md`; `window.SIM_API` v1 | Load, set params, run, inspect, and export; record request IDs, errors, assumptions/provenance |

## Execution Steps

1. Choose repository mode or operator mode from the decision table.
2. In repository mode, inspect the branch, source of truth, and tests; make the smallest owning-module change with a focused regression test.
3. In operator mode, build/start the live channel, use `SIM_API.loadScenario/setParams/start/pause/reset/getState/exportScenario`, and inspect structured errors and warnings without editing simulator source.
4. Run focused tests, `npm test`, and generated/package checks for repository changes; use Orca browser for UI changes.
5. Review the diff or operator evidence, including assumptions and unsupported behavior.
6. Commit repository work on the task branch or return design findings; report exact evidence without merging or publishing.

## Output Contract

Return changed files or design findings, commands/results, request IDs/errors, generated-dist status, assumptions/provenance, CI/PR status when applicable, and limitations or skipped checks.

## References

- `../../AGENTS.md`
- `../../docs/agent-operator.md`
- `../../docs/agent-playbook.md`
- `../../src/agent-api.js`
- `../../src/pricing.js`
- `../../src/engine.js`
- `../../src/app.js`
- `../../scenario.json`
