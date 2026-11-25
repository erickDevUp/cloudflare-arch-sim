import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import scenario from '../src/scenario.js';

const catalog = new Function('window',
  fs.readFileSync(new URL('../src/catalog.js', import.meta.url), 'utf8') + '\nreturn window.CATALOG;')({});

const minimal = () => ({
  version: 1,
  name: 'Tiny',
  nodes: [
    { id: 'a', type: 'traffic', x: 20, y: 20, p: { rate: 5 } },
    { id: 'b', type: 'workers', x: 200, y: 20 }
  ],
  edges: [{ from: 'a', to: 'b' }]
});

test('validates and fills catalog defaults', () => {
  const { scenario: s, error } = scenario.validate(minimal(), catalog);
  assert.equal(error, null);
  assert.equal(s.version, 1);
  assert.equal(s.name, 'Tiny');
  assert.equal(s.nodes[0].p.rate, 5);
  assert.equal(s.nodes[0].p.concurrency, 1); // traffic default
  assert.equal(s.nodes[1].p.latency, 6); // workers default
  assert.deepEqual(s.edges, [{ from: 'a', to: 'b' }]);
});

test('keeps an optional edge weight', () => {
  const raw = minimal();
  raw.edges[0].weight = 0.25;
  const { scenario: s, error } = scenario.validate(raw, catalog);
  assert.equal(error, null);
  assert.equal(s.edges[0].weight, 0.25);
});

test('keeps unknown node types as-is in one line and never crashes', () => {
  const raw = minimal();
  raw.nodes.push({ id: 'c', type: 'quantum_lb', x: 1, y: 1 });
  raw.edges.push({ from: 'b', to: 'c' });
  const { scenario: s, error, dropped } = scenario.validate(raw, catalog);
  assert.equal(dropped, 0); // preserved, not lost, so writers can keep it
  assert.equal(s.nodes.length, 3);
  assert.equal(s.nodes[2].type, 'quantum_lb');
  assert.equal(s.edges.length, 2);
  assert.match(error, /^Scenario: /);
  assert.equal(error.split('\n').length, 1);
  assert.match(error, /unknown node type "quantum_lb".*kept as-is/);
});

test('keeps unknown fields and params as-is so edits cannot delete them', () => {
  const raw = minimal();
  raw.colour = 'red';
  raw.nodes[0].shape = 'circle';
  raw.nodes[1].p = { replicas: 3 };
  raw.edges[0].label = 'sync';
  const { scenario: s, error, dropped } = scenario.validate(raw, catalog);
  assert.equal(dropped, 0);
  assert.equal(s.nodes.length, 2);
  assert.equal(s.colour, 'red');
  assert.equal(s.nodes[0].shape, 'circle');
  assert.equal(s.nodes[1].p.replicas, 3);
  assert.equal(s.edges[0].label, 'sync');
  assert.match(error, /unknown field "colour"/);
  assert.match(error, /unknown field "shape" on nodes\[0\]/);
  assert.match(error, /unknown param "replicas"/);
  assert.match(error, /unknown field "label" on edges\[0\]/);
  assert.equal(error.split('\n').length, 1);
});

test('missing x/y get a deterministic, non-overlapping layout', () => {
  const raw = {
    version: 1,
    nodes: [
      { id: 'a', type: 'traffic' },
      { id: 'b', type: 'workers' },
      { id: 'c', type: 'd1' }
    ],
    edges: []
  };
  const first = scenario.validate(raw, catalog).scenario;
  const second = scenario.validate(raw, catalog).scenario;
  assert.deepEqual(first.nodes, second.nodes);
  const spots = first.nodes.map(n => n.x + ',' + n.y);
  assert.equal(new Set(spots).size, 3);
  first.nodes.forEach(n => {
    assert.equal(typeof n.x, 'number');
    assert.equal(typeof n.y, 'number');
  });
});

test('reports only genuine losses so writers can reject them', () => {
  const dangling = minimal();
  dangling.edges.push({ from: 'a', to: 'missing' });
  const edge = scenario.validate(dangling, catalog);
  assert.equal(edge.dropped, 1);
  assert.equal(edge.scenario.edges.length, 1);

  const duplicate = { version: 1, nodes: [{ id: 'a', type: 'traffic' }, { id: 'a', type: 'workers' }], edges: [] };
  assert.equal(scenario.validate(duplicate, catalog).dropped, 1);
  assert.equal(new Set(scenario.validate(duplicate, catalog).scenario.nodes.map(n => n.id)).size, 2);

  const light = minimal();
  light.nodes.push({ id: 'c', type: 'quantum_lb', x: 1, y: 1 });
  light.extra = true;
  light.nodes[0].shape = 'circle';
  assert.equal(scenario.validate(light, catalog).dropped, 0); // preserved: safe to write
});

test('alias is bounded and control characters are rejected', () => {
  const raw = minimal();
  const vector = '<img src=x onerror="window.__xss=1">';
  raw.nodes[0].alias = vector;
  const kept = scenario.validate(raw, catalog);
  assert.equal(kept.scenario.nodes[0].alias, vector); // valid text, escaped when rendered
  assert.equal(kept.dropped, 0);

  const long = minimal();
  long.nodes[0].alias = 'x'.repeat(scenario.MAX_ALIAS + 1);
  const tooLong = scenario.validate(long, catalog);
  assert.equal('alias' in tooLong.scenario.nodes[0], false);
  assert.equal(tooLong.dropped, 1);
  assert.match(tooLong.error, /longer than 80 characters/);

  const control = minimal();
  control.nodes[0].alias = 'bad\u0007name';
  const bad = scenario.validate(control, catalog);
  assert.equal('alias' in bad.scenario.nodes[0], false);
  assert.equal(bad.dropped, 1);
  assert.match(bad.error, /control characters/);
});

test('out-of-range params clamp to the catalog bounds and are reported', () => {
  const raw = minimal();
  raw.nodes[0].p = { rate: -10 }; // traffic rate, editable floor is 1
  const { scenario: s, error, dropped } = scenario.validate(raw, catalog);
  assert.equal(s.nodes[0].p.rate, 1);
  assert.equal(dropped, 1);
  assert.match(error, /"rate" on node "a" is outside \[1, 100000\], using 1/);

  const price = minimal();
  price.nodes[1].p = { price: -1, units: -5, cpuMs: -2 };
  const out = scenario.validate(price, catalog);
  assert.equal(out.scenario.nodes[1].p.price, 0);
  assert.equal(out.scenario.nodes[1].p.units, 0);
  assert.equal(out.scenario.nodes[1].p.cpuMs, 0);
  assert.equal(out.dropped, 3);

  const high = minimal();
  high.nodes[1].p = { concurrency: 99999999, latency: 999999 };
  const capped = scenario.validate(high, catalog);
  assert.equal(capped.scenario.nodes[1].p.concurrency, 1000000);
  assert.equal(capped.scenario.nodes[1].p.latency, 60000);
});

test('source concurrency 0 is a documented legacy value; negatives still fail', () => {
  const zero = minimal();
  zero.nodes[0].p = { rate: 5, concurrency: 0, latency: 0 };
  const a = scenario.validate(zero, catalog);
  assert.equal(a.scenario.nodes[0].p.concurrency, 1);
  assert.equal(a.dropped, 0);
  assert.match(a.error, /legacy source concurrency 0 on node "a" normalized to 1/);

  const negative = minimal();
  negative.nodes[0].p = { concurrency: -5 };
  const b = scenario.validate(negative, catalog);
  assert.equal(b.scenario.nodes[0].p.concurrency, 1);
  assert.equal(b.dropped, 1);
  assert.match(b.error, /"concurrency" on node "a" is outside/);
});

test('prototype names are rejected as types, params and fields', () => {
  ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'].forEach(type => {
    const raw = { version: 1, nodes: [{ id: 'x', type: type }], edges: [] };
    const res = scenario.validate(raw, catalog);
    assert.equal(res.dropped, 1, type);
    assert.equal(res.scenario.nodes.length, 0, type);
  });

  const param = minimal();
  param.nodes[0].p = JSON.parse('{"__proto__": 1}');
  const p = scenario.validate(param, catalog);
  assert.equal(p.dropped, 1);
  assert.equal(Object.hasOwn(p.scenario.nodes[0].p, '__proto__'), false);

  const field = minimal();
  field.nodes[0]['constructor'] = 'x';
  const f = scenario.validate(field, catalog);
  assert.equal(f.dropped, 1);
  assert.equal(Object.hasOwn(f.scenario.nodes[0], 'constructor'), false);
});

test('generated ids never collide with given ids, before or after', () => {
  const later = { version: 1, nodes: [{ type: 'traffic' }, { id: 'n1', type: 'workers' }], edges: [] };
  const a = scenario.validate(later, catalog);
  assert.deepEqual(a.scenario.nodes.map(n => n.id), ['n2', 'n1']);
  assert.equal(a.dropped, 0);

  const duplicate = { version: 1, nodes: [{ id: 'n2', type: 'traffic' }, { type: 'workers' }], edges: [] };
  const b = scenario.validate(duplicate, catalog);
  assert.deepEqual(b.scenario.nodes.map(n => n.id), ['n2', 'n3']);
});

test('negative edge weight is clamped and reported', () => {
  const raw = minimal();
  raw.edges[0].weight = -5;
  const { scenario: s, error, dropped } = scenario.validate(raw, catalog);
  assert.equal(s.edges[0].weight, 0);
  assert.equal(dropped, 1);
  assert.match(error, /weight on edges\[0\] is negative, using 0/);
});

test('merge re-adds stored unknown data but keeps known removals possible', () => {
  const stored = {
    version: 1,
    name: 'Stored',
    preview: true,
    nodes: [
      { id: 'a', type: 'traffic', x: 1, y: 1, p: { rate: 5, replicas: 3 }, shade: 'neon' },
      { id: 'q', type: 'quantum_lb', x: 2, y: 2, note: 'future' },
      { id: 'gone', type: 'workers', x: 3, y: 3, p: {} }
    ],
    edges: [{ from: 'a', to: 'q', label: 'sync' }, { from: 'a', to: 'gone' }]
  };
  const stored1 = scenario.validate(stored, catalog).scenario;
  const incoming = {
    version: 1,
    name: 'Edited',
    nodes: [{ id: 'a', type: 'traffic', x: 10, y: 10, p: { rate: 9 } }],
    edges: []
  };
  const merged = scenario.merge(incoming, stored1, catalog);
  assert.equal(merged.name, 'Edited');
  assert.equal(merged.nodes[0].p.rate, 9); // incoming known value wins
  assert.equal(merged.nodes[0].x, 10);
  assert.equal(merged.nodes[0].shade, 'neon'); // unknown node field survives
  assert.equal(merged.nodes[0].p.replicas, 3); // unknown param survives
  assert.equal(merged.preview, true); // unknown root field survives
  assert.equal(merged.nodes.some(n => n.id === 'q'), true); // opaque node survives
  assert.equal(merged.nodes.some(n => n.id === 'gone'), false); // known removal stays possible
  assert.deepEqual(merged.edges.find(e => e.to === 'q'), { from: 'a', to: 'q', label: 'sync' });
});

test('merge preserves a stored opaque node\'s extras when a known node reuses its id', () => {
  const stored = scenario.validate({
    version: 1,
    nodes: [
      { id: 'a', type: 'traffic', x: 1, y: 1, p: { rate: 5 } },
      { id: 'q', type: 'quantum_lb', x: 2, y: 2, note: 'future', p: { replicas: 3, hint: 0.4 } },
      { id: 's', type: 'shade', x: 3, y: 3 }
    ],
    edges: [{ from: 'q', to: 's', label: 'link' }]
  }, catalog).scenario;
  const incoming = scenario.validate({
    version: 1,
    nodes: [
      { id: 'a', type: 'traffic', x: 1, y: 1, p: { rate: 5 } },
      { id: 'q', type: 'traffic', x: 9, y: 9, p: { rate: 7 } },
      { id: 'h1', type: 'workers', x: 4, y: 4, p: {} }
    ],
    edges: [{ from: 'a', to: 'h1' }]
  }, catalog).scenario;
  const merged = scenario.merge(incoming, stored, catalog);
  const q = merged.nodes.find(n => n.id === 'q');
  assert.equal(q.type, 'traffic'); // incoming identity/type wins
  assert.equal(q.x, 9);
  assert.equal(q.p.rate, 7);
  assert.equal(q.note, 'future'); // opaque extras survive the id reuse
  assert.equal(q.p.replicas, 3);
  assert.equal(q.p.hint, 0.4);
  assert.equal(merged.nodes.some(n => n.id === 's' && n.type === 'shade'), true);
  assert.deepEqual(merged.edges.find(e => e.from === 'q' && e.to === 's'), { from: 'q', to: 's', label: 'link' });
});

test('merge completes a partial opaque node from the stored copy', () => {
  const stored = scenario.validate({
    version: 1,
    nodes: [
      { id: 'a', type: 'traffic', x: 1, y: 1, p: { rate: 5 } },
      { id: 'q', type: 'quantum_lb', x: 22, y: 33, note: 'future', p: { replicas: 3 } }
    ],
    edges: [{ from: 'a', to: 'q' }]
  }, catalog).scenario;
  const incoming = scenario.validate({
    version: 1,
    nodes: [
      { id: 'a', type: 'traffic', x: 1, y: 1, p: { rate: 5 } },
      { id: 'q', type: 'quantum_lb' }
    ],
    edges: []
  }, catalog).scenario;
  const merged = scenario.merge(incoming, stored, catalog);
  const q = merged.nodes.find(n => n.id === 'q');
  assert.equal(q.type, 'quantum_lb');
  assert.equal(q.note, 'future');
  assert.equal(q.x, 22);
  assert.equal(q.y, 33);
  assert.equal(q.p.replicas, 3);
});

test('mergeConflict flags an id reuse whose opaque extras cannot be attached', () => {
  const stored = scenario.validate({
    version: 1,
    nodes: [{ id: 'q', type: 'quantum_lb', x: 1, y: 2, p: { replicas: 3 } }],
    edges: []
  }, catalog).scenario;
  const incoming = scenario.validate({
    version: 1,
    nodes: [{ id: 'q', type: 'traffic' }],
    edges: []
  }, catalog).scenario;
  delete incoming.nodes[0].p; // cannot hold the stored opaque params
  assert.deepEqual(scenario.mergeConflict(incoming, stored, catalog), {
    id: 'q', storedType: 'quantum_lb', incomingType: 'traffic'
  });
  incoming.nodes[0].p = {};
  assert.equal(scenario.mergeConflict(incoming, stored, catalog), null);
});

test('mergeConflict flags an opaque id reused by a different unknown type', () => {
  const stored = scenario.validate({
    version: 1,
    nodes: [{ id: 'q', type: 'quantum_lb', note: 'future' }],
    edges: []
  }, catalog).scenario;
  const incoming = scenario.validate({
    version: 1,
    nodes: [{ id: 'q', type: 'hyper_loop' }],
    edges: []
  }, catalog).scenario;
  assert.deepEqual(scenario.mergeConflict(incoming, stored, catalog), {
    id: 'q', storedType: 'quantum_lb', incomingType: 'hyper_loop'
  });
  incoming.nodes[0].type = 'quantum_lb';
  assert.equal(scenario.mergeConflict(incoming, stored, catalog), null);
});

test('nextNodeSeq reserves every existing numeric id, opaque ones included', () => {
  assert.equal(scenario.nextNodeSeq([]), 1);
  assert.equal(scenario.nextNodeSeq([{ id: 'a' }, { id: 'n2' }]), 3);
  assert.equal(scenario.nextNodeSeq([{ id: 'n1' }, { id: 'n9' }, { id: 'x' }]), 10);
});

test('legacy external workers_ai scenarios migrate without losing token fields', () => {
  const raw = minimal();
  raw.nodes.push({ id: 'm', type: 'workers_ai', p: {
    concurrency: 24, latency: 900, inPrice: 3, outPrice: 15, inTokens: 1000, outTokens: 500
  } });
  raw.edges.push({ from: 'b', to: 'm' });
  const { scenario: s, error, dropped } = scenario.validate(raw, catalog);
  assert.equal(error, null);
  assert.equal(dropped, 0);
  assert.equal(s.nodes[2].type, 'external_model');
  assert.equal(s.nodes[2].p.inPrice, 3);
  assert.deepEqual(scenario.decode(scenario.encode(s)), s);
});

test('the origin/main default scenario migrates its null external model fields', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('./legacy-default.json', import.meta.url), 'utf8'));
  const { scenario: s, error, dropped } = scenario.validate(raw, catalog);
  assert.equal(error, null);
  assert.equal(dropped, 0);
  assert.equal(s.nodes.length, 12);
  assert.equal(s.edges.length, 10);
  assert.equal(s.nodes.find(n => n.id === 'n7').type, 'external_model');
  assert.equal(s.nodes.find(n => n.id === 'n7').p.inPrice, null);
  assert.deepEqual(scenario.decode(scenario.encode(s)), s);
});

test('native Workers AI keeps token counts and fills Neuron rates', () => {
  const raw = minimal();
  raw.nodes.push({ id: 'm', type: 'workers_ai', p: { inTokens: 1000, outTokens: 500 } });
  const { scenario: s, error } = scenario.validate(raw, catalog);
  assert.equal(error, null);
  assert.equal(s.nodes[2].type, 'workers_ai');
  assert.equal(s.nodes[2].p.neuronsIn, 4625);
  assert.equal(s.nodes[2].p.neuronsOut, 30475);
});

test('Durable Object transport choices validate and round-trip', () => {
  const raw = minimal();
  raw.nodes.push({ id: 'd', type: 'durable_objects', p: { objects: 100, transport: 'hibernatable', activeSeconds: 1000 } });
  const { scenario: s, error } = scenario.validate(raw, catalog);
  assert.equal(error, null);
  assert.equal(s.nodes[2].p.transport, 'hibernatable');
  assert.deepEqual(scenario.decode(scenario.encode(s)), s);
  raw.nodes[2].p.transport = 'carrier-pigeon';
  const bad = scenario.validate(raw, catalog);
  assert.equal(bad.dropped, 1);
  assert.match(bad.error, /invalid value for "transport"/);
});

test('Images and Stream audit fields validate without opaque-node fallback', () => {
  const raw = {
    version: 1,
    nodes: [
      { id: 'i', type: 'images', p: { uniqueTransforms: 5000, pricePerThousand: 0.5 } },
      { id: 's', type: 'stream', p: { minutesStored: 1000, minutesDelivered: 100000, storagePrice: 5, deliveryPricePerThousand: 1 } }
    ],
    edges: []
  };
  const { scenario: s, error, dropped } = scenario.validate(raw, catalog);
  assert.equal(error, null);
  assert.equal(dropped, 0);
  assert.deepEqual(s.nodes.map(n => n.type), ['images', 'stream']);
  assert.deepEqual(scenario.decode(scenario.encode(s)), s);
});

test('the shipped scenario.json validates cleanly', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../scenario.json', import.meta.url), 'utf8'));
  const { scenario: s, error, dropped } = scenario.validate(raw, catalog);
  assert.equal(error, null);
  assert.equal(dropped, 0);
  assert.equal(s.nodes.length, 12);
  assert.equal(s.edges.length, 10);
});

test('a plain click is not a change; a moved node is', () => {
  const origin = { x: 20, y: 30 };
  assert.equal(scenario.moved({ x: 20, y: 30 }, origin), false);
  assert.equal(scenario.moved({ x: 20.5, y: 30 }, origin), true);
  assert.equal(scenario.moved(null, origin), false);
});

test('rejects a non-object scenario without throwing', () => {
  assert.equal(scenario.validate(null, catalog).scenario, null);
  assert.equal(scenario.validate([], catalog).scenario, null);
  assert.equal(scenario.validate('nope', catalog).scenario, null);
  assert.equal(scenario.validate(null, catalog).dropped, 1);
});

test('normalizes idempotently, field order included', () => {
  const raw = minimal();
  raw.nodes[0].alias = 'Front door';
  raw.extra = true;
  const a = scenario.validate(raw, catalog).scenario;
  const b = scenario.validate(JSON.parse(JSON.stringify(a)), catalog).scenario;
  assert.equal(JSON.stringify(b), JSON.stringify(a));
});

test('encode/decode round-trips through a #s= link', () => {
  const raw = minimal();
  raw.edges[0].weight = 2;
  const s = scenario.validate(raw, catalog).scenario;
  const encoded = scenario.encode(s);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  const hash = '#s=' + encoded;
  assert.deepEqual(scenario.decode(hash), s);
  assert.deepEqual(scenario.decode(encoded), s);
});

test('size guard keeps the link usable', () => {
  const raw = minimal();
  raw.name = 'x'.repeat(scenario.MAX_HASH * 2);
  assert.equal(scenario.encode(raw), null);
  assert.equal(scenario.decode('a'.repeat(scenario.MAX_HASH + 1)), null);
  assert.equal(scenario.decode('not base64 !!!'), null);
  assert.equal(scenario.decode(''), null);
});
