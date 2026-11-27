import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ux = require('../src/ux.js');
const core = require('../src/state-core.cjs');

globalThis.CATALOG = { types: { workers: { name: 'Workers' }, traffic: { name: 'Traffic' } } };

test('save status distinguishes saving, saved, rejection, server and network failures', () => {
  assert.equal(ux.saveStatus({ type: 'local' }).message, 'Local only');
  assert.equal(ux.saveStatus({ type: 'saving' }).phase, 'saving');
  assert.equal(ux.saveStatus({ type: 'saved' }).message, 'All changes saved');
  assert.deepEqual(ux.saveStatus({ type: 'unsaved' }), {
    phase: 'unsaved', message: 'Unsaved changes', retryable: false
  });
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

test('sheet focus trap cycles the ordered set and redirects escaped focus', () => {
  const focusable = ['retry', 'close', 'costs', 'connect'];
  assert.equal(ux.trapFocus('retry', true, focusable), 'connect');
  assert.equal(ux.trapFocus('connect', false, focusable), 'retry');
  assert.equal(ux.trapFocus('close', true, focusable), 'retry');
  assert.equal(ux.trapFocus('close', false, focusable), 'costs');
  assert.equal(ux.trapFocus('zoom', false, focusable), 'retry');
  assert.equal(ux.trapFocus('zoom', true, focusable), 'connect');
  assert.equal(ux.trapFocus('close', false, []), null);
});

test('banner errors are scoped and channel failures take priority', () => {
  const save = { message: 'Save failed' };
  const copy = { message: 'Link too large' };
  const channel = { message: 'Disconnected' };
  const errors = { save, copy };
  assert.equal(ux.bannerError(errors), save);
  delete errors.copy;
  assert.equal(ux.bannerError(errors), save);
  errors.channel = channel;
  assert.equal(ux.bannerError(errors), channel);
  delete errors.channel;
  delete errors.save;
  assert.equal(ux.bannerError(errors), null);
});

test('sheet focusables include summaries even inside closed details', () => {
  const el = (tag, opts) => ({
    tagName: tag,
    disabled: !!opts.disabled,
    offsetParent: opts.offsetParent === false ? null : {},
    closest: () => opts.closedDetails ? {} : null
  });
  assert.equal(ux.sheetFocusable(el('SUMMARY', { closedDetails: true })), true);
  assert.equal(ux.sheetFocusable(el('A', { closedDetails: true })), false);
  assert.equal(ux.sheetFocusable(el('A', {})), true);
  assert.equal(ux.sheetFocusable(el('BUTTON', { disabled: true })), false);
  assert.equal(ux.sheetFocusable(el('INPUT', { offsetParent: false })), false);
});

test('recovered bootstrap keeps pending or dirty local edits instead of applying stored data', () => {
  assert.equal(core.bootstrapAction(false, false, false), 'apply');
  assert.equal(core.bootstrapAction(true, false, false), 'identity');
  assert.equal(core.bootstrapAction(false, true, false), 'identity');
  assert.equal(core.bootstrapAction(false, false, true), 'identity');
  assert.equal(core.bootstrapAction(true, true, true), 'identity');
});

test('state core centralizes saving and persisted identity transitions', () => {
  const state = {
    scenarioRevision: null, scenarioHash: null, dirty: true, saving: false,
    saveError: { code: 'SAVE_FAILED', message: 'failed' }
  };
  core.setSaving(state, true);
  assert.equal(state.saving, true);
  assert.deepEqual(core.markSaved(state, { revision: '4', hash: 'hash-4' }), {
    revision: 4, hash: 'hash-4', etag: '"hash-4"'
  });
  assert.equal(state.scenarioRevision, 4);
  assert.equal(state.scenarioHash, 'hash-4');
  assert.equal(state.dirty, false);
  assert.equal(state.saveError, null);
  core.setSaving(state, false);
  assert.equal(state.saving, false);

  const rollback = Object.assign({}, state, { runId: 'run-7', saving: true });
  core.restoreIdentity(rollback, {
    scenarioRevision: null, scenarioHash: null, dirty: true,
    saveError: { code: 'SAVE_FAILED', message: 'failed' }
  });
  assert.equal(rollback.runId, 'run-7');
  assert.equal(rollback.saving, true);
  assert.equal(rollback.dirty, true);
  assert.equal(rollback.scenarioRevision, null);
});
