#!/usr/bin/env node
// npm CLI entry point: print the bundled HTML path, or run the local server.
// No dependencies beyond Node 18+ and the files shipped in this package.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const html = path.join(root, 'dist', 'cloudflare-arch-sim.html');

const usage = `cloudflare-arch-sim — local architecture simulator

Usage:
  cloudflare-arch-sim [flags]

Flags:
  --path              Print the path to the bundled HTML and exit.
  --port <port>       Listen on 1-65535 (default 8787).
  --scenario <file>   Scenario JSON file (default: bundled scenario.json).
  --help              Show this help.

With no flags the bundled HTML is served together with the state-channel
endpoints on http://127.0.0.1:8787/ (GET /scenario, POST /scenario, /events).
`;

const args = process.argv.slice(2);
const fail = message => {
  console.error(message);
  process.exit(1);
};
const value = name => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const next = args[i + 1];
  if (!next || next.startsWith('--')) fail('Missing value for ' + name + '.');
  return next;
};
const scenarioProblem = file => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.nodes)) {
      return 'expected an object with a "nodes" array';
    }
    return null;
  } catch (err) {
    if (err.code === 'ENOENT') return 'file does not exist';
    if (err instanceof SyntaxError) return 'invalid JSON';
    return 'cannot read file';
  }
};

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(usage);
} else if (args.includes('--path')) {
  process.stdout.write(html + '\n');
} else {
  const portValue = value('--port');
  const port = portValue === null ? 8787 : Number(portValue);
  if (portValue !== null && (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65535)) {
    fail('Invalid --port: ' + portValue + '; expected an integer from 1 to 65535.');
  }
  const scenarioValue = value('--scenario');
  const scenario = scenarioValue === null ? path.join(root, 'scenario.json') : path.resolve(scenarioValue);
  const problem = scenarioProblem(scenario);
  if (problem) fail('Invalid --scenario: ' + scenario + ' (' + problem + ').');
  const serverArgs = ['--port', String(port), '--scenario', scenario, '--file', html];

  // Delegating keeps one implementation of the HTTP channel: the CLI only
  // translates flags into paths rooted at the installed package.
  process.argv = [process.argv[0], path.join(root, 'serve.mjs'), ...serverArgs];
  await import(pathToFileURL(path.join(root, 'serve.mjs')).href);
}
