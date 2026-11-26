#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import API from './src/agent-api.js';
import CATALOG from './src/catalog.js';
import ENGINE from './src/engine.js';
import PRICING from './src/pricing.js';
import SCENARIO from './src/scenario.js';
import HEADLESS from './src/headless-service.js';

const noArgs = z.object({}).strict();
const scenarioInput = z.record(z.string(), z.unknown())
  .describe('Version 1 scenario object with nodes and edges arrays; unknown root fields are preserved.');
const loadOptions = z.object({
  resetRuntime: z.boolean().optional().describe('Reset time, spend, requests, model spend, and Queue state; defaults to true.')
}).strict().describe('In-memory load options. MCP v1 always validates strictly and never persists.');
const paramsInput = z.record(z.string(), z.unknown())
  .describe('Non-empty node parameter patch using catalog names and finite numeric or enum values.');
const exportOptions = z.object({
  assessment: z.boolean().optional().describe('Include Cloudflare/model billing, node metrics, and diagnostics.'),
  provenance: z.boolean().optional().describe('Include pricing and per-node provenance.')
}).strict();

const API_METHODS = [
  'capabilities', 'validate', 'loadScenario', 'setParams', 'setPlan', 'setBillingInputs',
  'run', 'pause', 'reset', 'getState', 'exportScenario'
];

const TOOL_SPECS = [
  {
    name: 'sim_capabilities',
    description: 'Return simulator versions, supported node types, limits, deterministic clock, and local stdio boundary.',
    schema: noArgs,
    run: service => {
      const result = service.capabilities();
      if (result.ok) {
        result.data.transport = 'stdio';
        result.data.methods = API_METHODS.slice();
      }
      return result;
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'sim_validate_scenario',
    description: 'Strictly validate and canonicalize a scenario without changing simulator state.',
    schema: z.object({ scenario: scenarioInput }).strict(),
    path: '/scenario',
    run: (service, args) => service.validate(args.scenario),
    annotations: { readOnlyHint: true }
  },
  {
    name: 'sim_load_scenario',
    description: 'Atomically load a strict version 1 scenario into memory and start a fresh run identity.',
    schema: z.object({ scenario: scenarioInput, options: loadOptions.optional() }).strict(),
    path: '/scenario',
    run: (service, args) => service.loadScenario(args.scenario, args.options)
  },
  {
    name: 'sim_set_node_params',
    description: 'Atomically patch one known node using catalog-backed validation and recompute its assessment.',
    schema: z.object({
      nodeId: z.string().min(1).describe('Existing safe node id.'),
      params: paramsInput
    }).strict(),
    path: '/params',
    run: (service, args) => service.setParams(args.nodeId, args.params)
  },
  {
    name: 'sim_set_plan',
    description: 'Set the Cloudflare plan to free, paid, or custom and recompute billing without resetting runtime.',
    schema: z.object({
      plan: z.enum(['free', 'paid', 'custom']).describe('Cloudflare plan used for allowances and monthly cost.')
    }).strict(),
    path: '/plan',
    run: (service, args) => service.setPlan(args.plan)
  },
  {
    name: 'sim_set_billing_inputs',
    description: 'Atomically set a finite Custom base fee of at least 0 and/or budget of at least 1 USD/month.',
    schema: z.object({
      inputs: z.object({
        baseFee: z.number().finite().nonnegative().optional().describe('Custom monthly base fee in USD.'),
        budget: z.number().finite().min(1).optional().describe('Custom monthly budget threshold in USD.')
      }).strict()
    }).strict(),
    path: '/inputs',
    run: (service, args) => service.setBillingInputs(args.inputs)
  },
  {
    name: 'sim_advance',
    description: 'Pause and advance by an exact number of simulated seconds, up to 31536000 per call.',
    schema: z.object({
      seconds: z.number().finite().positive().max(API.LIMITS.maxRunSeconds).describe('Exact simulated seconds to advance.')
    }).strict(),
    path: '/seconds',
    run: (service, args) => service.run({ seconds: args.seconds })
  },
  {
    name: 'sim_pause',
    description: 'Pause simulated advancement without changing counters or architecture.',
    schema: noArgs,
    run: service => service.pause()
  },
  {
    name: 'sim_reset',
    description: 'Clear runtime counters and Queue state, preserve architecture and billing inputs, and start a fresh run identity.',
    schema: noArgs,
    run: service => service.reset()
  },
  {
    name: 'sim_get_state',
    description: 'Return the complete deterministic state snapshot, assessment, diagnostics, assumptions, and provenance.',
    schema: noArgs,
    run: service => service.getState(),
    annotations: { readOnlyHint: true }
  },
  {
    name: 'sim_export_scenario',
    description: 'Export the canonical in-memory scenario with optional assessment and provenance; never writes a file.',
    schema: z.object({ options: exportOptions.optional() }).strict(),
    path: '/options',
    run: (service, args) => service.exportScenario(args.options),
    annotations: { readOnlyHint: true }
  }
];

export const TOOL_NAMES = Object.freeze(TOOL_SPECS.map(spec => spec.name));
export const TOOL_SCHEMAS = Object.freeze(Object.fromEntries(TOOL_SPECS.map(spec => [spec.name, spec.schema])));

function pointer(path) {
  if (!Array.isArray(path) || !path.length) return '/';
  return '/' + path.map(part => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

function schemaErrorCode(name, issue) {
  if (issue.path[0] === 'scenario') return API.ERROR_CODES.INVALID_SCENARIO;
  if (issue.path[0] === 'options') return API.ERROR_CODES.INVALID_OPTIONS;
  if (name === 'sim_advance') return API.ERROR_CODES.INVALID_OPTIONS;
  if (name === 'sim_set_plan') return API.ERROR_CODES.INVALID_PARAMS;
  if (name === 'sim_set_node_params') {
    if (issue.path[0] === 'nodeId') return API.ERROR_CODES.UNKNOWN_NODE;
    return API.ERROR_CODES.INVALID_PARAMS;
  }
  if (name === 'sim_set_billing_inputs') {
    if (issue.code === 'unrecognized_keys') return API.ERROR_CODES.UNSUPPORTED_PARAMETER;
    if (issue.code === 'too_small') return API.ERROR_CODES.PARAMETER_OUT_OF_RANGE;
    return API.ERROR_CODES.INVALID_PARAMS;
  }
  return 'INVALID_ARGUMENTS';
}

function toolResult(result, fallbackPath) {
  const envelope = result && result.error
    ? Object.assign({}, result, { error: Object.assign({}, result.error, { path: result.error.path || fallbackPath || '/' }) })
    : result;
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: !envelope.ok
  };
}

function invalidArguments(service, name, issues) {
  const first = issues[0];
  const path = pointer(first.path);
  const code = schemaErrorCode(name, first);
  const details = {
    issues: issues.map(issue => {
      const item = { path: pointer(issue.path), code: issue.code };
      if (issue.keys) item.keys = issue.keys;
      return item;
    })
  };
  return toolResult(service._fail(code, 'Invalid arguments for ' + name, details), path);
}

function registerTools(server, service) {
  TOOL_SPECS.forEach(spec => {
    server.registerTool(spec.name, {
      title: spec.name,
      description: spec.description,
      inputSchema: spec.schema,
      annotations: spec.annotations
    }, args => toolResult(spec.run(service, args), spec.path));
  });
  server.server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = request.params.name;
    const spec = TOOL_SPECS.find(item => item.name === name);
    if (!spec) {
      return toolResult(service._fail('UNKNOWN_TOOL', 'Unknown MCP tool', { tool: name }), '/name');
    }
    const parsed = spec.schema.safeParse(request.params.arguments === undefined ? {} : request.params.arguments);
    if (!parsed.success) return invalidArguments(service, name, parsed.error.issues);
    return toolResult(await spec.run(service, parsed.data), spec.path);
  });
}

function registerResources(server, defaultScenario, catalog, pricing) {
  server.registerResource('Default scenario', 'scenario://default', {
    description: 'Bundled source scenario shipped with the package; independent of the current in-memory session.',
    mimeType: 'application/json'
  }, uri => ({ contents: [{ uri: uri.href, text: JSON.stringify(defaultScenario, null, 2) }] }));
  server.registerResource('Node catalog', 'catalog://nodes', {
    description: 'Supported node types, defaults, editable ranges, enums, groups, and provenance notes.',
    mimeType: 'application/json'
  }, uri => ({ contents: [{ uri: uri.href, text: JSON.stringify(catalog, null, 2) }] }));
  server.registerResource('Pricing provenance', 'pricing://provenance', {
    description: 'Pricing as-of date, hours-per-month convention, plans, source links, and verified dimensions.',
    mimeType: 'application/json'
  }, uri => ({
    contents: [{
      uri: uri.href,
      text: JSON.stringify({
        asOf: pricing.asOf,
        hoursPerMonth: pricing.hoursPerMonth,
        plans: pricing.plans,
        sources: pricing.sources,
        dimensions: pricing.dims
      }, null, 2)
    }]
  }));
}

function registerPrompts(server) {
  server.registerPrompt('assess_architecture', {
    title: 'Assess a Cloudflare architecture',
    description: 'Guided strict load, configure, exact-time advance, inspection, and export workflow.',
    argsSchema: {
      goal: z.string().max(2000).optional().describe('Architecture goal or workload to assess.')
    }
  }, ({ goal }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          'Assess a Cloudflare architecture with the deterministic simulator.',
          goal ? 'Goal: ' + goal : '',
          '1. Call sim_capabilities and read catalog://nodes plus pricing://provenance.',
          '2. Build a version 1 scenario, call sim_validate_scenario, then sim_load_scenario.',
          '3. Use sim_set_node_params, then compare free, paid, or custom with sim_set_plan and sim_set_billing_inputs.',
          '4. Call sim_advance with exact simulated seconds; never rely on wall-clock waits. Use sim_pause to stop and sim_reset to clear runtime counters.',
          '5. Inspect sim_get_state for bottlenecks, Queue backlog/drops, billing, warnings, assumptions, and provenance.',
          '6. Call sim_export_scenario with assessment and provenance enabled for the final artifact.',
          'MCP v1 is local stdio only: do not expect filesystem save, HTTP transport, or remote deployment.',
          'Report runId, simulated time, requestCount, key metrics, monthly Cloudflare cost, separate model spend, warnings, and limitations.'
        ].filter(Boolean).join('\n')
      }
    }]
  }));
}

export function createMcpServer(options = {}) {
  const catalog = options.catalog || CATALOG;
  const pricing = options.pricing || PRICING;
  const defaultScenario = options.defaultScenario === undefined
    ? JSON.parse(fs.readFileSync(new URL('./scenario.json', import.meta.url), 'utf8'))
    : options.defaultScenario;
  const service = options.service || HEADLESS.createHeadlessSimulator({
    scenario: SCENARIO,
    catalog,
    pricing,
    engine: ENGINE,
    agentApi: API,
    defaultScenario
  });
  const server = new McpServer({ name: 'cloudflare-arch-sim', version: '1.0.0' });
  registerTools(server, service);
  registerResources(server, defaultScenario, catalog, pricing);
  registerPrompts(server);
  return { server, service };
}

export async function startMcpServer(options = {}) {
  const created = createMcpServer(options);
  await created.server.connect(new StdioServerTransport());
  return created;
}

const invoked = process.argv[1] && fs.realpathSync(process.argv[1]);
const entry = fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked && pathToFileURL(invoked).href === pathToFileURL(entry).href) {
  startMcpServer().catch(error => {
    console.error('cloudflare-arch-sim-mcp: ' + String((error && error.message) || error));
    process.exitCode = 1;
  });
}
