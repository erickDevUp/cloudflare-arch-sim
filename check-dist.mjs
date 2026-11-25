import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudflare-arch-sim-dist-'));
const freshPath = path.join(temporary, 'cloudflare-arch-sim.html');
const trackedPath = path.join(root, 'dist', 'cloudflare-arch-sim.html');
let status = 0;

try {
  const result = spawnSync(process.execPath, [path.join(root, 'build.mjs'), '--out', freshPath], {
    cwd: root,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    status = result.status || 1;
  } else if (!fs.existsSync(trackedPath)) {
    console.error('Missing dist/cloudflare-arch-sim.html; run npm run build.');
    status = 1;
  } else if (!fs.readFileSync(freshPath).equals(fs.readFileSync(trackedPath))) {
    console.error('dist is stale; run npm run build and commit dist/cloudflare-arch-sim.html.');
    status = 1;
  } else {
    console.log('dist matches a fresh build.');
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.exitCode = status;
