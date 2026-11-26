# MCP stdio server

The `cloudflare-arch-sim-mcp` workspace exposes the deterministic simulator to MCP clients over local stdio. It is an adapter over the existing `SIM_API` contract, engine, catalog, scenario validator, and pricing modules; it does not implement a second simulation.

## Quick path

1. Install root and workspace dependencies with `npm ci` in this repository.
2. Start the server with `npm run mcp` or `node packages/mcp/mcp-server.mjs`.
3. Configure an MCP client to spawn that command.
4. Call `sim_capabilities`, then follow the `assess_architecture` prompt.

```json
{
  "mcpServers": {
    "cloudflare-arch-sim": {
      "command": "node",
      "args": ["/absolute/path/to/cloudflare-arch-sim/packages/mcp/mcp-server.mjs"]
    }
  }
}
```

In a workspace checkout, npm links the MCP package bin into `node_modules/.bin`:

```json
{
  "mcpServers": {
    "cloudflare-arch-sim": {
      "command": "cloudflare-arch-sim-mcp",
      "args": []
    }
  }
}
```

The root `cloudflare-arch-sim` package intentionally does not expose this bin. Publishing the MCP workspace separately is deferred; this PR does not add a root-package wrapper.

The MCP workspace requires Node 18 or newer and owns `@modelcontextprotocol/sdk` `^1.32.2` and `zod` `^4.6.7`; the root package has no runtime dependencies. stdout carries only MCP protocol frames; diagnostics go to stderr. The SDK's HTTP-only Hono adapter remains inside the MCP dependency tree and is never imported or started by this stdio server.

## Boundary

| Surface | Browser `window.SIM_API` | MCP v1 |
|---|---|---|
| Transport | Page-local JavaScript | Local stdio JSON-RPC |
| State | Current page instance | Current child-process instance |
| Advancement | Wall-clock loop plus exact `run()` | Exact `sim_advance` only |
| Persistence | Optional revisioned `/scenario` save | None |
| Scenario merge | Server-side lossless merge | None |
| Remote transport | None | None |
| Filesystem writes | Through the optional live channel | None |

MCP sessions are in memory. Loading or editing a scenario does not modify `scenario.json`, and `sim_export_scenario` returns data without writing it anywhere. Each client-spawned process starts from `scenario.json` with a fresh run identity.

## Tools

Every success uses the `SIM_API` envelope:

```json
{ "ok": true, "data": {}, "requestId": "sim-v1-000001" }
```

Failures set MCP `isError: true` and return the same envelope in both text and structured content:

```json
{
  "ok": false,
  "error": {
    "code": "PARAMETER_OUT_OF_RANGE",
    "message": "Node params are outside catalog ranges",
    "path": "/params",
    "details": { "nodeId": "queue", "params": [{ "param": "concurrency", "min": 1, "max": 1000000 }] }
  },
  "requestId": "sim-v1-000004"
}
```

`path` is a JSON Pointer into the tool input. Schema failures add stable `INVALID_ARGUMENTS`, `UNKNOWN_TOOL`, or the matching `SIM_API` validation code with `details.issues`. Invalid calls never mutate state, and every tool call consumes a deterministic request id.

| Tool | Input | Success data |
|---|---|---|
| `sim_capabilities` | None | Versions, node types, limits, clock, supported methods, and stdio persistence status |
| `sim_validate_scenario` | `{ scenario }` | `{ valid, scenario, warnings, unsupported }` |
| `sim_load_scenario` | `{ scenario, options?: { resetRuntime?: boolean } }` | Loaded scenario, warnings, run identity, and dirty status |
| `sim_set_node_params` | `{ nodeId, params }` | `{ nodeId, params }` after atomic recomputation |
| `sim_set_plan` | `{ plan: "free" \| "paid" \| "custom" }` | Updated state snapshot |
| `sim_set_billing_inputs` | `{ inputs: { baseFee?: number, budget?: number } }` | Updated state snapshot |
| `sim_advance` | `{ seconds }` | Runtime identity after exact simulated-time advancement |
| `sim_pause` | None | Runtime identity with `running: false` |
| `sim_reset` | None | Fresh run identity with runtime counters cleared |
| `sim_get_state` | None | Complete state, assessment, diagnostics, assumptions, and provenance |
| `sim_export_scenario` | `{ options?: { assessment?: boolean, provenance?: boolean } }` | Canonical scenario with optional assessment/provenance |

`sim_load_scenario` is always strict. `resetRuntime` defaults to `true`; `false` preserves time, spend, request counters, model spend, and matching Queue state while replacing the architecture. MCP does not accept `persist` or `strict: false`.

`sim_advance` accepts finite seconds greater than zero and at most `31536000` per call. It pauses first and never reads wall-clock time.

## Resources

| URI | Content |
|---|---|
| `scenario://default` | Bundled `scenario.json`, independent of current session edits |
| `catalog://nodes` | Node types, defaults, ranges, enums, groups, and provenance notes |
| `pricing://provenance` | Pricing `asOf`, hours/month, plans, sources, and dimensions |

## Prompt

`assess_architecture` accepts an optional `goal` string and returns a guided workflow: inspect capabilities and references, validate and load, configure params and plan/billing, advance exact simulated seconds, inspect state, and export assessment plus provenance.

## Example workflow

```js
const checked = await client.callTool({
  name: 'sim_validate_scenario',
  arguments: {
    scenario: {
      version: 1,
      name: 'Queue backpressure candidate',
      nodes: [
        { id: 'source', type: 'traffic', p: { rate: 10 } },
        { id: 'queue', type: 'queues', p: { concurrency: 1, latency: 1000, retention: 100 } }
      ],
      edges: [{ from: 'source', to: 'queue' }]
    }
  }
});

await client.callTool({ name: 'sim_load_scenario', arguments: { scenario: checked.structuredContent.data.scenario } });
await client.callTool({ name: 'sim_set_plan', arguments: { plan: 'paid' } });
await client.callTool({ name: 'sim_advance', arguments: { seconds: 120 } });
const state = await client.callTool({ name: 'sim_get_state', arguments: {} });
const assessment = await client.callTool({
  name: 'sim_export_scenario',
  arguments: { options: { assessment: true, provenance: true } }
});
```

Inspect `state.structuredContent.data.nodes.queue.backlog`, `.drops`, warnings, Cloudflare monthly cost, separate model spend, and provenance before drawing a conclusion.

## Verification

```sh
npm test -- tests/headless-service.test.mjs packages/mcp/test/*.test.mjs
node packages/mcp/mcp-server.mjs </dev/null
npm run pack:check
npm run pack:check --workspace cloudflare-arch-sim-mcp
```

The SDK integration test spawns this server over stdio and uses the MCP client to list/call every tool, read all resources, get the prompt, exercise structured failures, and prove invalid calls leave state unchanged. The direct-entry test confirms empty stdout and stderr when no protocol input is sent.

## Limitations

- No filesystem save, scenario merge, HTTP listener, remote transport, subscriptions, publishing, or deployment.
- No browser controls, chaos buttons, wall-clock start, or speed controls; use exact simulated seconds.
- State is process-local and is lost when the client stops the server.
- The underlying rate model remains an approximation, not a load test or Cloudflare emulator. See [the operator guide](agent-operator.md#known-limitations).

## References

- [packages/mcp/mcp-server.mjs](../packages/mcp/mcp-server.mjs) — tool schemas, resources, prompt, and stdio entry.
- [src/headless-service.js](../src/headless-service.js) — deterministic host around `SIM_API`.
- [src/agent-api.js](../src/agent-api.js) — envelopes, strict validation, snapshots, and provenance.
- [docs/agent-operator.md](agent-operator.md) — shared v1 semantics and browser contract.
