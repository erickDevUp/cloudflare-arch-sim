---
name: cloudflare-arch-sim
description: "Trigger: cloudflare-arch-sim, simulator change, architecture design, pricing, scenario, queue physics, MCP stdio. Edit the repo or operate SIM_API v1 safely."
license: ISC
metadata:
  author: "erickDevUp"
  version: "1.0"
---

## Activation Contract

Load this skill for repository changes or for using the simulator to design/evaluate an architecture. For browser operator work, read `docs/agent-operator.md`; for MCP clients, read `docs/mcp.md`; for repository work, read `AGENTS.md` and `docs/agent-playbook.md` before editing.

## Hard Rules

- Treat `src/pricing.js` as the pricing source of truth and `scenario.json` as the default scenario source of truth.
- Preserve M/M/c, full fan-out, cache forwarding, simulated-time queue backlog, retention drops, and separate Cloudflare/model spend.
- Never hand-edit `dist/`; rebuild it and keep it fresh.
- Preserve unknown scenario data and lossless merge behavior.
- Keep UI work in English and defer localization/copy changes to Phase 2 after P0.
- Use Orca's browser for UI checks.
- Treat `window.SIM_API` v1 as the stable browser agent contract; treat `window.__SIM__`, HTTP/SSE, and DOM controls as compatibility surfaces.
- Treat MCP v1 as a local stdio adapter over the same semantics. It has no filesystem save, merge, network listener, or remote transport; stdout is protocol-only.
- Work on a task branch; do not merge, publish, deploy, or change accounts.

## Decision Gates

| Goal | Authority | Required checks |
|---|---|---|
| Change the simulator codebase | `AGENTS.md` and `docs/agent-playbook.md`; owning source/tests | Focused/full tests; build, dist, pack, coverage, and smoke checks as applicable |
| Design/evaluate an architecture in a browser | `docs/agent-operator.md`; `window.SIM_API` v1 | Check capabilities, validate, load, set params and plan/billing inputs, run exact simulated seconds, inspect state/assessment, export provenance, and save only when persistence is intended |
| Design/evaluate an architecture through MCP | `docs/mcp.md`; `sim_*` tools | Check capabilities/resources, validate/load, configure, advance exact seconds, inspect state, and export assessment/provenance; never expect persistence |

## Execution Steps

1. Choose repository mode or operator mode from the decision table.
2. In repository mode, inspect the branch, source of truth, and tests; make the smallest owning-module change with a focused regression test.
3. In browser operator mode, use `SIM_API.capabilities/validate/loadScenario/setParams/setPlan/setBillingInputs/setSpeed/run/getState/exportScenario`, and use `save()` only for intentional persistence. In MCP mode, use the `sim_*` tools and `assess_architecture` prompt. Record request IDs, run/revision identity, structured errors, dirty/save status, assumptions, and provenance.
4. Run focused tests, `npm test`, and generated/package checks for repository changes; use Orca browser for UI changes.
5. Review the diff or operator evidence, including assumptions and unsupported behavior.
6. Commit repository work on the task branch or return design findings; report exact evidence without merging or publishing.

## Plan and billing example

Use the machine contract instead of DOM controls:

```js
const api = window.SIM_API;
const free = api.setPlan('free');
const custom = api.setPlan('custom');
const billed = api.setBillingInputs({ baseFee: 25, budget: 1000 });
if (!free.ok || !custom.ok || !billed.ok) throw new Error('Plan or billing update failed');
const snapshot = api.getState().data;
```

Compare `snapshot.cloudflare.allowances` and `snapshot.cloudflare.monthly` across Free, Paid, and Custom. Invalid plans or billing patches return structured errors without changing state.

## Output Contract

Return changed files or design findings, commands/results, request IDs/errors, run/revision identity, generated-dist status, assumptions/provenance, save/conflict status, CI/PR status when applicable, and limitations or skipped checks.

## References

- `../../AGENTS.md`
- `../../docs/agent-operator.md`
- `../../docs/mcp.md`
- `../../packages/mcp/mcp-server.mjs`
- `../../src/headless-service.js`
- `../../docs/agent-playbook.md`
- `../../src/agent-api.js`
- `../../src/pricing.js`
- `../../src/engine.js`
- `../../src/app.js`
- `../../scenario.json`
