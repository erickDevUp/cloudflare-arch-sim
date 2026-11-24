#!/usr/bin/env node
// npm CLI entry point: print the bundled HTML path, or run the local server.
// No dependencies beyond Node 18+ and the files shipped in this package.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const html = path.join(root, 'dist', 'cloudflare-arch-sim.html');

const usage = `cloudflare-arch-sim — local architecture simulator

Usage:
  cloudflare-arch-sim [flags]

Flags:
  --path              Print the path to the bundled HTML and exit.
  --port <port>       Listen on this port (default 8787).
  --scenario <file>   Path to scenario.json for the shared channel.
  --help              Show this help.

With no flags the bundled HTML is served together with the state-channel
endpoints on http://127.0.0.1:8787/ (GET /scenario, POST /scenario, /events).
`;

const args = process.argv.slice(2);
const value = name => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(usage);
} else if (args.includes('--path')) {
  process.stdout.write(html + '\n');
} else {
  const port = value('--port');
  if (port !== null && !/^\d+$/.test(port)) {
    console.error('Invalid --port: ' + port);
    process.exit(1);
  }
  const scenario = value('--scenario') || path.join(root, 'scenario.json');
  const serverArgs = ['--port', port || '8787', '--scenario', scenario, '--file', html];

  // Delegating keeps one implementation of the HTTP channel: the CLI only
  // translates flags into paths rooted at the installed package.
  process.argv = [process.argv[0], path.join(root, 'serve.mjs'), ...serverArgs];
  await import(pathToFileURL(path.join(root, 'serve.mjs')).href);
}
