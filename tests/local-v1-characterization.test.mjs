import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import API from '../src/agent-api.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const clone = value => JSON.parse(JSON.stringify(value));
const flush = async () => {
  for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve));
};

function element() {
  const classes = new Set();
  const attributes = new Map();
  const listeners = new Map();
  let html = '';
  return {
    style: {}, dataset: {}, children: [], value: '', hidden: false, clientWidth: 1200, clientHeight: 800,
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; if (value === '') this.children.length = 0; },
    classList: {
      add(...names) { names.forEach(name => classes.add(name)); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : !!force;
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      }
    },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    dispatchEvent(event) {
      (listeners.get(event.type) || []).forEach(callback => callback(event));
    },
    appendChild(child) { this.children.push(child); return child; },
    remove() {},
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800 }; },
    getTotalLength() { return 100; },
    getPointAtLength(length) { return { x: length, y: 0 }; },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
}

function response(scenario, revision, hash, status = 200) {
  const payload = status === 200
    ? { ok: true, revision, hash, eventId: 'scenario-' + revision, scenario: clone(scenario) }
    : {
      code: status === 409 ? 'STORAGE_CONFLICT' : 'SAVE_FAILED',
      error: status === 409 ? 'Scenario: storage changed since the loaded revision' : 'Scenario save failed'
    };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: name => name.toLowerCase() === 'content-type' ? 'application/json'
        : name.toLowerCase() === 'etag' && hash ? '"' + hash + '"' : null
    },
    json: async () => clone(payload)
  };
}

async function browser(initial) {
  let stored = clone(initial);
  let revision = 1;
  let hash = 'hash-1';
  const posts = [];
  const sources = [];
  const elements = new Map();
  const nodeLayer = element();
  const rateInput = element();
  rateInput.tagName = 'INPUT';
  rateInput.dataset = { f: 'rate' };
  rateInput.min = '0';
  rateInput.max = '1000000';
  rateInput.value = '10';
  const inspector = element();
  inspector.querySelectorAll = selector => selector.indexOf('input[data-f]') >= 0 ? [rateInput] : [];
  elements.set('#node-layer', nodeLayer);
  elements.set('#inspect', inspector);
  elements.set('#inspect input[data-f=rate]', rateInput);
  const document = {
    title: '',
    body: element(),
    activeElement: null,
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    querySelectorAll(selector) {
      return selector === '.node' ? nodeLayer.children.filter(el => el.className.indexOf('node') >= 0) : [];
    },
    createElement: element,
    createElementNS: element,
    addEventListener() {},
    elementFromPoint() { return null; }
  };
  const timers = new Map();
  let timerId = 0;
  const setTimeout = (callback, delay) => {
    const id = ++timerId;
    timers.set(id, { callback, delay });
    return id;
  };
  const clearTimeout = id => timers.delete(id);
  const sandbox = {
    console, document, setTimeout, clearTimeout, TextEncoder, TextDecoder,
    location: { protocol: 'http:', hash: '' },
    navigator: {},
    innerWidth: 1400,
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener() {},
    requestAnimationFrame() {},
    EventSource: class {
      constructor() { sources.push(this); }
      close() {}
    },
    fetch: async (url, options = {}) => {
      if (url === '/scenario' && options.method === 'POST') {
        return new Promise(resolve => posts.push({ body: options.body, resolve }));
      }
      return Object.assign(response(stored, revision, hash), { json: async () => clone(stored) });
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['pricing.js', 'catalog.js', 'scenario.js', 'engine.js', 'state-core.mjs', 'agent-api.js', 'ux.js', 'app.js']) {
    const source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    vm.runInContext(source, sandbox, { filename: file });
  }
  await flush();
  assert.equal(sources.length, 1);
  assert.equal(sandbox.__SIM__.export().name, initial.name);
  return {
    window: sandbox,
    posts,
    editRate(rate) {
      const source = nodeLayer.children.find(el => el.dataset.id === 'source');
      source.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
      rateInput.value = String(rate);
      rateInput.dispatchEvent({ type: 'input' });
    },
    runTimers(delay = 400) {
      for (const [id, timer] of Array.from(timers)) {
        if (timer.delay <= delay) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    emit(scenario, nextRevision, nextHash, clientId = 'another-client') {
      sources[0].onmessage({ data: JSON.stringify({
        clientId, scenario: clone(scenario), revision: nextRevision, hash: nextHash,
        eventId: 'scenario-' + nextRevision
      }) });
    }
  };
}

function baseline() {
  return {
    version: 1,
    name: 'Characterization baseline',
    nodes: [
      { id: 'source', type: 'traffic', p: { rate: 10 } },
      { id: 'api', type: 'workers', p: { latency: 20, cpuMs: 5 } }
    ],
    edges: [{ from: 'source', to: 'api' }]
  };
}

test('Node consumers import state-dependent modules directly in fresh processes', () => {
  assert.ok(fs.readFileSync(path.join(root, 'src/state-core.cjs'))
    .equals(fs.readFileSync(path.join(root, 'src/state-core.mjs'))));
  for (const modulePath of ['src/agent-api.js', 'src/headless-service.js']) {
    const result = spawnSync(process.execPath, ['-e', 'require(' + JSON.stringify('./' + modulePath) + ')'], {
      cwd: root,
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

test('SIM_API v1 preserves its method surface, envelopes, error codes, and request IDs', async () => {
  const { window } = await browser(baseline());
  const api = window.SIM_API;
  assert.deepEqual(Object.keys(api), [
    'version', 'apiVersion', 'capabilities', 'validate', 'loadScenario', 'setParams', 'setPlan',
    'setBillingInputs', 'reset', 'run', 'pause', 'setSpeed', 'start', 'getState', 'exportScenario',
    '_fail', 'save', 'load', 'set', 'state', 'export'
  ]);
  assert.equal(api.version, 1);
  assert.equal(api.apiVersion, 1);
  assert.deepEqual(clone(api.capabilities().data.methods), [
    'capabilities', 'validate', 'loadScenario', 'setParams', 'setPlan', 'setBillingInputs',
    'start', 'pause', 'reset', 'run', 'setSpeed', 'getState', 'exportScenario', 'save',
    'load', 'set', 'state', 'export'
  ]);
  assert.deepEqual(API.ERROR_CODES, {
    INVALID_SCENARIO: 'INVALID_SCENARIO',
    UNSUPPORTED_SCHEMA_VERSION: 'UNSUPPORTED_SCHEMA_VERSION',
    UNSUPPORTED_NODE_TYPE: 'UNSUPPORTED_NODE_TYPE',
    UNSUPPORTED_PARAMETER: 'UNSUPPORTED_PARAMETER',
    PARAMETER_OUT_OF_RANGE: 'PARAMETER_OUT_OF_RANGE',
    UNKNOWN_NODE: 'UNKNOWN_NODE',
    INVALID_PARAMS: 'INVALID_PARAMS',
    INVALID_OPTIONS: 'INVALID_OPTIONS',
    INVALID_STATE: 'INVALID_STATE',
    SAVE_FAILED: 'SAVE_FAILED',
    CHANNEL_UNAVAILABLE: 'CHANNEL_UNAVAILABLE',
    STORAGE_CONFLICT: 'STORAGE_CONFLICT',
    INTERNAL_ERROR: 'INTERNAL_ERROR'
  });
  const state = api.getState();
  assert.equal(state.ok, true);
  assert.equal(state.requestId, 'sim-v1-000002');
  assert.deepEqual(Object.keys(state).sort(), ['data', 'ok', 'requestId']);
  const invalid = api.validate({ version: 2, nodes: [] });
  assert.equal(invalid.requestId, 'sim-v1-000003');
  assert.deepEqual(clone(invalid), {
    ok: false,
    error: {
      code: 'UNSUPPORTED_SCHEMA_VERSION',
      message: 'Unsupported scenario schema version',
      details: { expected: 1, received: 2 }
    },
    requestId: 'sim-v1-000003'
  });
  assert.equal(api.state().requestId, 'sim-v1-000004');
  const missing = api.set('missing', { rate: 1 });
  assert.equal(missing.error.code, 'UNKNOWN_NODE');
  assert.equal(missing.requestId, 'sim-v1-000005');
  assert.deepEqual(Object.keys(window.__SIM__), ['load', 'export', 'getState']);
  assert.deepEqual(Object.keys(window.__SIM__.getState()), [
    'time', 'spent', 'rate', 'pathLat', 'running', 'speed', 'plan', 'baseFee', 'budget', 'requests',
    'requestCount', 'modelSpent', 'cpuRate', 'scenarioRevision', 'scenarioHash', 'runId', 'dirty',
    'saving', 'saveError', 'chaos', 'usage', 'monthly', 'modelSpend', 'nodes'
  ]);
});

test('browser SIM_API preserves dirty/save transitions when a newer edit arrives during save', async () => {
  const { window, posts } = await browser(baseline());
  const api = window.SIM_API;
  assert.equal(api.getState().data.dirty, false);
  const patched = api.setParams('source', { rate: 20 });
  assert.equal(patched.ok, true, JSON.stringify(patched));
  assert.equal(api.getState().data.dirty, true);
  assert.equal(api.getState().data.scenarioRevision, null);
  assert.equal(api.getState().data.scenarioHash, null);

  const firstSave = api.save();
  await flush();
  assert.equal(posts.length, 1);
  assert.equal(api.getState().data.saving, true);
  assert.equal(api.getState().data.dirty, true);
  api.setParams('source', { rate: 30 });
  posts[0].resolve(response(JSON.parse(posts[0].body), 2, 'hash-2'));
  assert.deepEqual(clone(await firstSave), {
    ok: true,
    data: { revision: 2, eventId: 'scenario-2', hash: 'hash-2', scenario: JSON.parse(posts[0].body) },
    requestId: 'sim-v1-000006'
  });
  assert.equal(api.getState().data.dirty, true);
  assert.equal(api.getState().data.saving, false);
  assert.equal(api.getState().data.scenarioRevision, null);
  assert.equal(api.getState().data.scenarioHash, null);
  assert.equal(api.getState().data.scenario.nodes[0].p.rate, 30);
  assert.equal(api.capabilities().data.persistence.revision, 2);

  const secondSave = api.save();
  await flush();
  assert.equal(posts.length, 2);
  posts[1].resolve(response(JSON.parse(posts[1].body), 3, 'hash-3'));
  assert.equal((await secondSave).ok, true);
  assert.equal(api.getState().data.dirty, false);
  assert.equal(api.getState().data.saving, false);
  assert.equal(api.getState().data.scenarioRevision, 3);
  assert.equal(api.getState().data.scenarioHash, 'hash-3');

  api.setParams('source', { rate: 40 });
  const failedSave = api.save();
  await flush();
  posts[2].resolve(response(null, 3, 'hash-3', 409));
  const failed = await failedSave;
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'STORAGE_CONFLICT');
  assert.equal(api.getState().data.dirty, true);
  assert.equal(api.getState().data.saving, false);
  assert.deepEqual(clone(api.getState().data.saveError), {
    code: 'STORAGE_CONFLICT',
    message: 'Scenario: storage changed since the loaded revision',
    details: { status: 409 }
  });
});

test('SSE same-scenario updates clear stale save status without resetting runtime identity', async () => {
  const { window, posts, emit } = await browser(baseline());
  const api = window.SIM_API;
  api.setParams('source', { rate: 20 });
  const failedSave = api.save();
  await flush();
  posts[0].resolve(response(null, 1, 'hash-1', 409));
  await failedSave;
  api.run({ seconds: 5 });
  const before = api.getState().data;
  const scenario = window.__SIM__.export();
  assert.equal(before.dirty, true);
  assert.equal(before.saveError.code, 'STORAGE_CONFLICT');
  assert.equal(before.time, 5);
  assert.equal(before.requestCount, 100);

  emit(scenario, 2, 'hash-2');
  const after = api.getState().data;
  assert.equal(after.dirty, false);
  assert.equal(after.saving, false);
  assert.equal(after.saveError, null);
  assert.equal(after.scenarioRevision, 2);
  assert.equal(after.scenarioHash, 'hash-2');
  assert.equal(after.runId, before.runId);
  assert.equal(after.time, before.time);
  assert.equal(after.requestCount, before.requestCount);
  assert.deepEqual(after.scenario, before.scenario);
  assert.equal(posts.length, 1);
});

test('failed autosave clears pending error and Retry when a peer saves the identical scenario', async () => {
  const initial = baseline();
  const first = await browser(initial);
  const peer = await browser(initial);
  const api = first.window.SIM_API;

  first.editRate(20);
  assert.equal(first.window.document.querySelector('#save-status').textContent, 'Saving scenario…');
  first.runTimers();
  await flush();
  assert.equal(first.posts.length, 1);
  first.posts[0].resolve(response(null, 1, 'hash-1', 500));
  await flush();

  const failed = api.getState().data;
  assert.equal(failed.dirty, true);
  assert.equal(failed.saveError.code, 'SAVE_FAILED');
  assert.equal(first.window.document.querySelector('#save-status').dataset.phase, 'error');
  assert.equal(first.window.document.querySelector('#channel-error').hidden, false);
  assert.equal(first.window.document.querySelector('#error-retry').hidden, false);

  api.run({ seconds: 5 });
  const before = api.getState().data;
  assert.equal(before.time, 5);
  assert.equal(before.requestCount, 100);

  assert.equal(peer.window.SIM_API.setParams('source', { rate: 20 }).ok, true);
  const peerSave = peer.window.SIM_API.save();
  await flush();
  assert.equal(peer.posts.length, 1);
  peer.posts[0].resolve(response(JSON.parse(peer.posts[0].body), 2, 'hash-2'));
  const saved = await peerSave;
  assert.equal(saved.ok, true);

  first.emit(saved.data.scenario, 2, 'hash-2');
  const after = api.getState().data;
  assert.equal(after.dirty, false);
  assert.equal(after.saveError, null);
  assert.equal(after.scenarioRevision, 2);
  assert.equal(after.scenarioHash, 'hash-2');
  assert.equal(after.runId, before.runId);
  assert.equal(after.time, before.time);
  assert.equal(after.requestCount, before.requestCount);
  assert.equal(first.window.document.querySelector('#save-status').textContent, 'All changes saved');
  assert.equal(first.window.document.querySelector('#save-status').dataset.phase, 'saved');
  assert.equal(first.window.document.querySelector('#channel-error').hidden, true);
  assert.equal(first.window.document.querySelector('#error-retry').hidden, true);
  assert.equal(first.posts.length, 1);
});
