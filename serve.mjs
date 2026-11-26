#!/usr/bin/env node
// State channel server: serves the built page, the scenario JSON and an SSE stream.
// No dependencies; Node 18+.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SCENARIO = require('./src/scenario.js');
const root = path.dirname(fileURLToPath(import.meta.url));

function send(res, code, type, body, headers) {
  res.writeHead(code, Object.assign({ 'content-type': type, 'cache-control': 'no-store' }, headers || {}));
  res.end(body);
}

const hashText = text => createHash('sha256').update(text).digest('hex');
const etagFor = hash => '"' + hash + '"';

const opaqueNodes = (scenario, catalog) =>
  scenario.nodes.filter(n => !Object.hasOwn(catalog.types, n.type));

function readStored(scenarioPath) {
  try {
    const text = fs.readFileSync(scenarioPath, 'utf8');
    JSON.parse(text); // only serve text that the page can parse
    return text;
  } catch (err) {
    return null;
  }
}

function storedScenario(scenarioPath, catalog) {
  const text = readStored(scenarioPath);
  if (text === null) return null;
  try {
    const { scenario } = SCENARIO.validate(JSON.parse(text), catalog);
    return scenario;
  } catch (err) {
    return null;
  }
}

function hostPort(host, port) {
  const h = String(host || '');
  return (h.indexOf(':') >= 0 && h.charAt(0) !== '[' ? '[' + h + ']' : h) + ':' + port;
}

export function createServer(options) {
  const scenarioPath = path.resolve(options.scenarioPath);
  const filePath = path.resolve(options.filePath);
  const catalog = options.catalog;
  const clients = new Set();
  const log = options.log || console;
  let revision = 1;
  const extraHost = options.allowedHost && options.allowedHost !== '0.0.0.0' && options.allowedHost !== '::'
    ? String(options.allowedHost).toLowerCase()
    : null;

  const allowedHosts = () => {
    const addr = server.address();
    const port = addr && addr.port;
    const hosts = new Set();
    if (!port) return hosts;
    hosts.add('127.0.0.1:' + port);
    hosts.add('localhost:' + port);
    hosts.add('[::1]:' + port);
    if (extraHost) hosts.add(hostPort(extraHost, port));
    return hosts;
  };

  const server = http.createServer((req, res) => {
    // Pin Host to the loopback pairs this server owns: comparing Origin with
    // Host would accept a DNS-rebinding pair. Origin null (file://) has no place
    // on the channel; the page must be the one served by this process.
    const allowed = allowedHosts();
    const host = String(req.headers.host || '').toLowerCase();
    const origin = req.headers.origin === undefined ? null : String(req.headers.origin).toLowerCase();
    if (!allowed.has(host)) {
      return send(res, 403, 'application/json', JSON.stringify({ error: 'Scenario: request Host is not an allowed loopback origin' }));
    }
    if (origin !== null && (origin === 'null' || !Array.from(allowed).some(h => origin === 'http://' + h))) {
      return send(res, 403, 'application/json', JSON.stringify({ error: 'Scenario: cross-origin request rejected' }));
    }
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      res.on('error', () => clients.delete(res));
      return;
    }

    if (url.pathname === '/scenario' && req.method === 'GET') {
      // Serve the stored bytes untouched: normalizing here would let the next
      // UI edit delete unknown nodes/fields without anyone noticing.
      const stored = readStored(scenarioPath);
      if (stored === null) {
        return send(res, 500, 'application/json', JSON.stringify({ error: 'Scenario: file is missing or not valid JSON' }));
      }
      try {
        const { error } = SCENARIO.validate(JSON.parse(stored), catalog);
        if (error) log.warn(error);
      } catch (e) { /* parse already passed */ }
      const hash = hashText(stored);
      return send(res, 200, 'application/json', stored, {
        etag: etagFor(hash),
        'x-scenario-revision': String(revision),
        'x-scenario-hash': hash
      });
    }

    if (url.pathname === '/scenario' && req.method === 'POST') {
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') {
        return send(res, 415, 'application/json', JSON.stringify({ error: 'Scenario: content-type must be application/json' }));
      }
      let body = '';
      let tooBig = false;
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 1e6) { body = ''; tooBig = true; }
      });
      req.on('end', () => {
        if (tooBig) return send(res, 413, 'application/json', JSON.stringify({ error: 'Scenario: body is larger than 1 MB' }));
        let raw;
        try { raw = JSON.parse(body); } catch (e) {
          return send(res, 400, 'application/json', JSON.stringify({ error: 'Scenario: body is not valid JSON' }));
        }
        if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) {
          return send(res, 400, 'application/json', JSON.stringify({ error: 'Scenario: POST body needs a "nodes" array' }));
        }
        const { scenario, error, dropped } = SCENARIO.validate(raw, catalog);
        if (!scenario || dropped > 0) {
          return send(res, 400, 'application/json', JSON.stringify({ error: error || 'Scenario: invalid' }));
        }
        const stored = storedScenario(scenarioPath, catalog);
        const storedText = readStored(scenarioPath);
        const storedHash = storedText === null ? null : hashText(storedText);
        const storedEtag = storedHash === null ? null : etagFor(storedHash);
        if (req.headers['if-match'] && req.headers['if-match'] !== storedEtag) {
          return send(res, 409, 'application/json', JSON.stringify({
            code: 'STORAGE_CONFLICT',
            error: 'Scenario: storage changed since the loaded revision',
            revision,
            hash: storedHash
          }));
        }
        // A type reuse whose stored data cannot be preserved is a conflict,
        // not a merge; reject it with both types named instead of dropping data.
        const conflict = SCENARIO.mergeConflict(scenario, stored, catalog);
        if (conflict) {
          return send(res, 400, 'application/json', JSON.stringify({
            code: 'STORAGE_CONFLICT',
            error: 'Scenario: node "' + conflict.id + '" type conflict: stored "' + conflict.storedType +
              '" cannot be replaced by "' + conflict.incomingType + '" without dropping its unknown data'
          }));
        }
        // New unknown node types are rejected; unknown data already in the file
        // is merged back so an omission in the POST can never delete it. A
        // partial opaque node that matches a stored opaque node by id and type
        // is completed from storage, not treated as a newly introduced type.
        const opaque = opaqueNodes(scenario, catalog);
        if (opaque.length) {
          const storedOpaque = stored ? opaqueNodes(stored, catalog) : [];
          const byId = new Map();
          const noId = new Set();
          storedOpaque.forEach(n => {
            if (typeof n.id === 'string' && n.id) byId.set(n.id, n);
            else noId.add(JSON.stringify(n));
          });
          const fresh = opaque.filter(n => {
            if (typeof n.id === 'string' && n.id) {
              const match = byId.get(n.id);
              return !match || match.type !== n.type;
            }
            return !noId.has(JSON.stringify(n));
          })[0];
          if (fresh) {
            return send(res, 400, 'application/json', JSON.stringify({
              error: 'Scenario: unknown node type "' + fresh.type + '" cannot be introduced by POST (only preserved from the file)'
            }));
          }
        }
        const merged = SCENARIO.merge(scenario, stored, catalog);
        const text = JSON.stringify(merged, null, 2) + '\n';
        const hash = hashText(text);
        const tmp = scenarioPath + '.' + process.pid + '.' + Date.now() + '.tmp';
        try {
          fs.mkdirSync(path.dirname(scenarioPath), { recursive: true });
          fs.writeFileSync(tmp, text);
          fs.renameSync(tmp, scenarioPath);
        } catch (err) {
          try { fs.unlinkSync(tmp); } catch (e) { /* nothing to clean */ }
          const message = String(err.message || err).split('\n')[0];
          log.warn('Cannot write ' + scenarioPath + ': ' + message);
          return send(res, 500, 'application/json', JSON.stringify({ error: 'Scenario: write failed: ' + message }));
        }
        revision++;
        const eventId = 'scenario-' + revision;
        const chunk = 'data: ' + JSON.stringify({
          clientId: req.headers['x-client-id'] || '', scenario: merged, revision, hash, eventId
        }) + '\n\n';
        clients.forEach(client => {
          if (!client.writableEnded) client.write(chunk);
        });
        return send(res, 200, 'application/json', JSON.stringify({
          ok: true, warning: error, revision, hash, eventId, scenario: merged
        }), {
          etag: etagFor(hash),
          'x-scenario-revision': String(revision),
          'x-scenario-hash': hash
        });
      });
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      try {
        return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(filePath, 'utf8'));
      } catch (err) {
        return send(res, 404, 'text/plain', 'Cannot read ' + filePath + ': run node build.mjs first.\n');
      }
    }

    send(res, 404, 'text/plain', 'not found\n');
  });

  return server;
}

// Tests use this to bind an ephemeral port without the CLI.
export function startServer(options) {
  const server = createServer(options);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const port = Number(arg('--port', 8787));
  const host = arg('--host', '127.0.0.1');
  const scenarioPath = path.resolve(arg('--scenario', 'scenario.json'));
  const filePath = path.resolve(arg('--file', 'dist/cloudflare-arch-sim.html'));
  const catalog = new Function('window',
    fs.readFileSync(path.join(root, 'src/catalog.js'), 'utf8') + '\nreturn window.CATALOG;')({});

  const explicitHost = args.indexOf('--host') >= 0 ? host : null;
  const server = createServer({ scenarioPath, filePath, catalog, allowedHost: explicitHost });
  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    console.log('page     http://' + hostPort(shown, port) + '/');
    console.log('scenario ' + scenarioPath);
    console.log('file     ' + filePath);
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      console.warn('warning  listening on ' + host + ' (not loopback): anyone who can reach this port can rewrite scenario.json');
    }
    try {
      if (fs.readFileSync(filePath, 'utf8').indexOf('window.__SCENARIO__ =') >= 0) {
        console.warn('warning  ' + filePath + ' embeds a scenario, which outranks GET /scenario; rebuild without --scenario for the live loop or point --file at a different build');
      }
    } catch (e) { /* the page 404 covers a missing build */ }
  });
}
