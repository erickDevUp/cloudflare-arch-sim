import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ux = require('../src/ux.js');

globalThis.CATALOG = { types: { workers: { name: 'Workers' }, traffic: { name: 'Traffic' } } };

test('save status distinguishes saving, saved, rejection, server and network failures', () => {
  assert.equal(ux.saveStatus({ type: 'local' }).message, 'Local only');
  assert.equal(ux.saveStatus({ type: 'saving' }).phase, 'saving');
  assert.equal(ux.saveStatus({ type: 'saved' }).message, 'All changes saved');
  assert.deepEqual(ux.saveStatus({ type: 'rejected', message: 'bad scenario' }), {
    phase: 'error', message: 'Scenario not saved: bad scenario', retryable: false
  });
  assert.equal(ux.saveStatus({ type: 'http', status: 500 }).retryable, true);
  assert.equal(ux.saveStatus({ type: 'http', status: 400 }).retryable, false);
  assert.equal(ux.saveStatus({ type: 'network' }).retryable, true);
  assert.equal(ux.saveStatus({ type: 'disconnected' }).retryable, true);
  assert.equal(ux.saveStatus({ type: 'unavailable', status: 503 }).retryable, true);
});

test('tabs wrap with arrow keys and support Home and End', () => {
  const tabs = ['cost', 'components'];
  assert.equal(ux.nextTab('cost', 'ArrowRight', tabs), 'components');
  assert.equal(ux.nextTab('components', 'ArrowRight', tabs), 'cost');
  assert.equal(ux.nextTab('components', 'ArrowLeft', tabs), 'cost');
  assert.equal(ux.nextTab('components', 'Home', tabs), 'cost');
  assert.equal(ux.nextTab('cost', 'End', tabs), 'components');
  assert.equal(ux.nextTab('cost', 'Escape', tabs), 'cost');
});

test('verified node notes do not mark workload fields as verified', () => {
  const def = { verified: 'Verified prices and limits.' };
  assert.deepEqual(ux.fieldProvenance(def, 'price'), {
    kind: 'verified', label: 'Verified default · editable'
  });
  assert.deepEqual(ux.fieldProvenance(def, 'latency'), {
    kind: 'assumption', label: 'Editable assumption'
  });
  assert.equal(ux.fieldProvenance({}, 'price').kind, 'assumption');
});

test('keyboard connect targets exclude the source and use accessible names', () => {
  const nodes = [
    { id: 'a', type: 'traffic', alias: 'Front door' },
    { id: 'b', type: 'workers' },
    { id: 'c', type: 'traffic' }
  ];
  assert.deepEqual(ux.connectTargets(nodes, 'a'), [
    { id: 'b', label: 'Workers' },
    { id: 'c', label: 'Traffic' }
  ]);
  assert.deepEqual(ux.connectTargets([], 'a'), []);
});
