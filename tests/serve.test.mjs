import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../serve.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const catalog = new Function('window',
  fs.readFileSync(path.join(rootDir, 'src/catalog.js'), 'utf8') + '\nreturn window.CATALOG;')({});
const pagePath = path.join(rootDir, 'dist', 'cloudflare-arch-sim.html');

const valid = () => ({
  version: 1,
  name: 'Serve test',
  nodes: [{ id: 'a', type: 'traffic', x: 1, y: 1, p: { rate: 5 } }],
  edges: []
});

function makeDir() {
  return fs.mkdtempSync(path.join(rootDir, '.tmp-serve-'));
}

async function start(dir) {
  const scenarioPath = path.join(dir, 'scenario.json');
  if (!fs.existsSync(scenarioPath)) fs.writeFileSync(scenarioPath, JSON.stringify(valid(), null, 2));
  const server = await startServer({
    scenarioPath: scenarioPath,
    filePath: pagePath,
    catalog,
    log: { warn() {}, log() {} }
  });
  return { server, base: 'http://127.0.0.1:' + server.address().port };
}

function stop(server, dir) {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

const post = (base, body, headers) => fetch(base + '/scenario', {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
  body: typeof body === 'string' ? body : JSON.stringify(body)
});

// Raw http.request so tests can spoof Host/Origin, which fetch forbids.
function raw(port, { method = 'GET', path: pathName = '/scenario', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('POST requires application/json (CORS-simple text/plain is refused)', async () => {
  const dir = makeDir();
  const { server, base } = await start(dir);
  try {
    const before = fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8');
    const res = await post(base, JSON.stringify(valid()), { 'content-type': 'text/plain' });
    assert.equal(res.status, 415);
    assert.equal(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'), before);
    assert.equal((await fetch(base + '/scenario')).status, 200);
  } finally {
    stop(server, dir);
  }
});

const hashText = text => createHash('sha256').update(text).digest('hex');

test('GET and POST expose revision/hash identity and stale saves conflict atomically', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'scenario.json');
  const { server, base } = await start(dir);
  try {
    const initial = await fetch(base + '/scenario');
    const initialText = await initial.text();
    const initialHash = hashText(initialText);
    assert.equal(initial.headers.get('x-scenario-revision'), '1');
    assert.equal(initial.headers.get('x-scenario-hash'), initialHash);
    assert.equal(initial.headers.get('etag'), '"' + initialHash + '"');

    const first = await post(base, { version: 1, name: 'Revision two', nodes: valid().nodes, edges: [] });
    assert.equal(first.status, 200);
    const firstPayload = await first.json();
    assert.equal(firstPayload.revision, 2);
    assert.equal(firstPayload.hash, hashText(fs.readFileSync(file, 'utf8')));
    assert.equal(first.headers.get('etag'), '"' + firstPayload.hash + '"');

    const before = fs.readFileSync(file, 'utf8');
    const stale = await post(base, { version: 1, name: 'Stale write', nodes: valid().nodes, edges: [] }, {
      'if-match': initial.headers.get('etag')
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'STORAGE_CONFLICT');
    assert.equal(fs.readFileSync(file, 'utf8'), before);

    const current = await post(base, { version: 1, name: 'Revision three', nodes: valid().nodes, edges: [] }, {
      'if-match': first.headers.get('etag')
    });
    assert.equal(current.status, 200);
    assert.equal((await current.json()).revision, 3);
  } finally {
    stop(server, dir);
  }
});

test('POST rejects a foreign Origin and accepts its own', async () => {
  const dir = makeDir();
  const { server, base } = await start(dir);
  try {
    const evil = await post(base, valid(), { origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    assert.equal((await fetch(base + '/scenario')).status, 200);

    const own = await post(base, { version: 1, name: 'Own origin', nodes: valid().nodes, edges: [] }, {
      origin: 'http://' + new URL(base).host
    });
    assert.equal(own.status, 200);
    assert.match(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'), /Own origin/);
  } finally {
    stop(server, dir);
  }
});

test('a failed write returns 500 and the server keeps serving', async (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('root bypasses directory permissions');
    return;
  }
  const dir = makeDir();
  const file = path.join(dir, 'scenario.json');
  fs.writeFileSync(file, JSON.stringify(valid(), null, 2));
  fs.chmodSync(dir, 0o500);
  const { server, base } = await start(dir);
  try {
    const res = await post(base, valid());
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /write failed/);
    assert.equal(server.listening, true);
    const get = await fetch(base + '/scenario');
    assert.equal(get.status, 200);
    assert.match(await get.text(), /Serve test/);
    const again = await post(base, valid());
    assert.equal(again.status, 500); // did not crash
  } finally {
    fs.chmodSync(dir, 0o700);
    stop(server, dir);
  }
});

test('GET serves the stored bytes and POST keeps unknown nodes and fields', async () => {
  const dir = makeDir();
  const stored = {
    version: 1,
    name: 'Lossless',
    nodes: [
      { id: 'a', type: 'traffic', x: 1, y: 1, p: { rate: 5 }, shade: 'neon' },
      { id: 'q', type: 'quantum_lb', x: 2, y: 2, note: 'future' }
    ],
    edges: [{ from: 'a', to: 'q' }],
    preview: true
  };
  const text = JSON.stringify(stored, null, 2) + '\n';
  fs.writeFileSync(path.join(dir, 'scenario.json'), text);
  const { server, base } = await start(dir);
  try {
    const get = await fetch(base + '/scenario');
    assert.equal(get.status, 200);
    assert.equal(await get.text(), text); // untouched, not normalized

    const res = await post(base, text);
    assert.equal(res.status, 200);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
    assert.deepEqual(written.nodes.map(n => n.type), ['traffic', 'quantum_lb']);
    assert.equal(written.nodes[0].shade, 'neon');
    assert.equal(written.preview, true);
    assert.deepEqual(written.edges, [{ from: 'a', to: 'q' }]);
    assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
    assert.equal((await fetch(base + '/scenario')).status, 200);
  } finally {
    stop(server, dir);
  }
});

test('prototype types are rejected but unknown params are preserved', async () => {
  const dir = makeDir();
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(valid()));
  const { server, base } = await start(dir);
  try {
    const ghost = await post(base, {
      version: 1,
      nodes: [{ id: 'x', type: 'constructor' }],
      edges: []
    });
    assert.equal(ghost.status, 400);
    assert.match((await ghost.json()).error, /unknown node type "constructor"/);

    const extra = await post(base, {
      version: 1,
      nodes: [{ id: 'a', type: 'traffic', x: 1, y: 1, p: { rate: 5, replicas: 3 } }],
      edges: []
    });
    assert.equal(extra.status, 200);
    assert.match((await extra.json()).warning, /unknown param "replicas"/);
    assert.match(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'), /replicas/);
  } finally {
    stop(server, dir);
  }
});

test('POST rejects a new unknown type but preserves one already in the file', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'scenario.json');
  fs.writeFileSync(file, JSON.stringify(valid()));
  const { server, base } = await start(dir);
  try {
    const fresh = await post(base, { version: 1, nodes: [{ id: 'q', type: 'quantum_lb' }], edges: [] });
    assert.equal(fresh.status, 400);
    assert.match((await fresh.json()).error, /unknown node type "quantum_lb" cannot be introduced/);

    const stored = {
      version: 1,
      name: 'Lossless',
      nodes: [{ id: 'a', type: 'traffic', x: 1, y: 1, p: { rate: 5 } }, { id: 'q', type: 'quantum_lb' }],
      edges: [{ from: 'a', to: 'q' }]
    };
    fs.writeFileSync(file, JSON.stringify(stored, null, 2) + '\n');
    const text = await (await fetch(base + '/scenario')).text();
    const kept = await post(base, text);
    assert.equal(kept.status, 200);
    assert.match(fs.readFileSync(file, 'utf8'), /quantum_lb/);
  } finally {
    stop(server, dir);
  }
});

test('a POST that omits stored unknown data cannot delete it', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'scenario.json');
  const stored = {
    version: 1,
    name: 'Stored',
    preview: true,
    nodes: [
      { id: 'a', type: 'traffic', x: 1, y: 1, p: { rate: 5 }, shade: 'neon' },
      { id: 'q', type: 'quantum_lb', x: 2, y: 2, note: 'future' }
    ],
    edges: [{ from: 'a', to: 'q', label: 'sync' }]
  };
  fs.writeFileSync(file, JSON.stringify(stored, null, 2) + '\n');
  const { server, base } = await start(dir);
  try {
    const res = await post(base, {
      version: 1,
      name: 'Edited',
      nodes: [{ id: 'a', type: 'traffic', x: 10, y: 10, p: { rate: 9 } }],
      edges: []
    });
    assert.equal(res.status, 200);
    const out = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(out.name, 'Edited');
    assert.equal(out.nodes[0].p.rate, 9);
    assert.equal(out.preview, true);
    assert.equal(out.nodes.find(n => n.id === 'a').shade, 'neon');
    assert.equal(out.nodes.some(n => n.id === 'q' && n.type === 'quantum_lb'), true);
    assert.deepEqual(out.edges.find(e => e.to === 'q'), { from: 'a', to: 'q', label: 'sync' });

    const get = await fetch(base + '/scenario');
    assert.equal(get.status, 200);
    const text = await get.text();
    assert.match(text, /quantum_lb/);
    assert.match(text, /neon/);
    assert.match(text, /preview/);
  } finally {
    stop(server, dir);
  }
});

test('POST with a known node reusing a stored opaque id preserves its extras', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'scenario.json');
  const stored = {
    version: 1,
    name: 'Stored',
    preview: true,
    nodes: [
      { id: 'a', type: 'traffic', x: 1, y: 1, p: { rate: 5 } },
      { id: 'q', type: 'quantum_lb', x: 2, y: 2, note: 'future', p: { replicas: 3, hint: 0.4 } },
      { id: 's', type: 'shade', x: 3, y: 3 }
    ],
    edges: [{ from: 'q', to: 's', label: 'link' }]
  };
  fs.writeFileSync(file, JSON.stringify(stored, null, 2) + '\n');
  const { server, base } = await start(dir);
  try {
    const res = await post(base, {
      version: 1,
      name: 'Edited',
      nodes: [
        { id: 'a', type: 'traffic', x: 1, y: 1, p: { rate: 5 } },
        { id: 'q', type: 'traffic', x: 9, y: 9, p: { rate: 7 } },
        { id: 'h1', type: 'workers', x: 4, y: 4, p: {} }
      ],
      edges: [{ from: 'a', to: 'h1' }]
    });
    assert.equal(res.status, 200);
    const out = JSON.parse(fs.readFileSync(file, 'utf8'));
    const q = out.nodes.find(n => n.id === 'q');
    assert.equal(q.type, 'traffic');
    assert.equal(q.x, 9);
    assert.equal(q.p.rate, 7);
    assert.equal(q.note, 'future');
    assert.equal(q.p.replicas, 3);
    assert.equal(q.p.hint, 0.4);
    assert.equal(out.preview, true);
    assert.equal(out.nodes.some(n => n.id === 's' && n.type === 'shade'), true);
    assert.deepEqual(out.edges.find(e => e.from === 'q' && e.to === 's'), { from: 'q', to: 's', label: 'link' });
  } finally {
    stop(server, dir);
  }
});

test('POST with a partial opaque node already in the file is completed from storage', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'scenario.json');
  const stored = {
    version: 1,
    nodes: [
      { id: 'a', type: 'traffic', x: 1, y: 1, p: { rate: 5 } },
      { id: 'q', type: 'quantum_lb', x: 22, y: 33, note: 'future', p: { replicas: 3 } }
    ],
    edges: [{ from: 'a', to: 'q' }]
  };
  fs.writeFileSync(file, JSON.stringify(stored, null, 2) + '\n');
  const { server, base } = await start(dir);
  try {
    const res = await post(base, {
      version: 1,
      nodes: [
        { id: 'a', type: 'traffic', x: 1, y: 1, p: { rate: 5 } },
        { id: 'q', type: 'quantum_lb' }
      ],
      edges: []
    });
    assert.equal(res.status, 200);
    const out = JSON.parse(fs.readFileSync(file, 'utf8'));
    const q = out.nodes.find(n => n.id === 'q');
    assert.equal(q.type, 'quantum_lb');
    assert.equal(q.note, 'future');
    assert.equal(q.x, 22);
    assert.equal(q.y, 33);
    assert.equal(q.p.replicas, 3);
    assert.deepEqual(out.edges, [{ from: 'a', to: 'q' }]);
  } finally {
    stop(server, dir);
  }
});

test('POST still rejects a genuinely new unknown type with an accurate error', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'scenario.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    nodes: [{ id: 'a', type: 'traffic', x: 1, y: 1, p: { rate: 5 } }],
    edges: []
  }));
  const { server, base } = await start(dir);
  try {
    const before = fs.readFileSync(file, 'utf8');
    const res = await post(base, { version: 1, nodes: [{ id: 'fresh', type: 'quantum_lb' }], edges: [] });
    assert.equal(res.status, 400);
    const error = (await res.json()).error;
    assert.match(error, /^Scenario: /);
    assert.match(error, /unknown node type "quantum_lb" cannot be introduced by POST/);
    assert.doesNotMatch(error, /already in the file|reused/); // no misleading claim
    assert.equal(fs.readFileSync(file, 'utf8'), before); // file untouched

    // The same type with an id already in the file is a merge, not a new type.
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      nodes: [{ id: 'q', type: 'quantum_lb', note: 'future' }],
      edges: []
    }));
    const kept = await post(base, { version: 1, nodes: [{ id: 'q', type: 'quantum_lb' }], edges: [] });
    assert.equal(kept.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).nodes[0].note, 'future');
  } finally {
    stop(server, dir);
  }
});

test('POST rejects an opaque id reused by a different type with an accurate error', async () => {
  const dir = makeDir();
  const file = path.join(dir, 'scenario.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    nodes: [{ id: 'q', type: 'quantum_lb', note: 'future' }],
    edges: []
  }));
  const { server, base } = await start(dir);
  try {
    const before = fs.readFileSync(file, 'utf8');
    const res = await post(base, { version: 1, nodes: [{ id: 'q', type: 'hyper_loop' }], edges: [] });
    assert.equal(res.status, 400);
    const error = (await res.json()).error;
    assert.match(error, /node "q" type conflict/);
    assert.match(error, /stored "quantum_lb" cannot be replaced by "hyper_loop"/);
    assert.equal(fs.readFileSync(file, 'utf8'), before); // no data dropped
  } finally {
    stop(server, dir);
  }
});

test('Host and Origin must be the loopback pair (DNS rebinding refused)', async () => {
  const dir = makeDir();
  const { server } = await start(dir);
  const port = server.address().port;
  try {
    const evil = 'evil.example:' + port;
    const write = await raw(port, {
      method: 'POST',
      headers: { host: evil, origin: 'http://' + evil, 'content-type': 'application/json' },
      body: JSON.stringify(valid())
    });
    assert.equal(write.status, 403);
    assert.match(write.body, /not an allowed loopback origin/);

    const sse = await raw(port, { path: '/events', headers: { host: evil, origin: 'http://' + evil } });
    assert.equal(sse.status, 403);
    const page = await raw(port, { path: '/', headers: { host: evil } });
    assert.equal(page.status, 403);

    const nul = await raw(port, {
      method: 'POST',
      headers: { host: '127.0.0.1:' + port, origin: 'null', 'content-type': 'application/json' },
      body: JSON.stringify(valid())
    });
    assert.equal(nul.status, 403);

    const localhost = await raw(port, {
      method: 'POST',
      headers: { host: 'localhost:' + port, 'content-type': 'application/json' },
      body: JSON.stringify(valid())
    });
    assert.equal(localhost.status, 200);
  } finally {
    stop(server, dir);
  }
});

test('negative source concurrency is rejected', async () => {
  const dir = makeDir();
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(valid()));
  const { server, base } = await start(dir);
  try {
    const res = await post(base, {
      version: 1,
      nodes: [{ id: 'a', type: 'traffic', x: 1, y: 1, p: { rate: 5, concurrency: -5 } }],
      edges: []
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /"concurrency" on node "a" is outside/);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'), /concurrency": -5/);
  } finally {
    stop(server, dir);
  }
});

test('GET on a broken file returns one line and keeps the server alive', async () => {
  const dir = makeDir();
  fs.writeFileSync(path.join(dir, 'scenario.json'), '{broken');
  const { server, base } = await start(dir);
  try {
    const res = await fetch(base + '/scenario');
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /^Scenario: /);
    assert.equal((await fetch(base + '/')).status, 200);
  } finally {
    stop(server, dir);
  }
});
