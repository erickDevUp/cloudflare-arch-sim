/* Scenario schema: pure functions shared by the page, the server and the tests.
   No DOM access, no network. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SCENARIO = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const VERSION = 1;
  const MAX_HASH = 8000; // base64url chars: past this the #s= link stops being usable
  const MAX_ALIAS = 80;
  const CONTROL = /[\u0000-\u001f\u007f]/;
  const ROOT_KEYS = ['version', 'name', 'nodes', 'edges'];
  const NODE_KEYS = ['id', 'type', 'x', 'y', 'alias', 'p'];
  const EDGE_KEYS = ['from', 'to', 'weight'];

  const fin = v => typeof v === 'number' && isFinite(v);

  // True only when a drag actually changed the node position; a plain click
  // selects without publishing anything back to the channel.
  function moved(node, origin) {
    return !!node && !!origin && (node.x !== origin.x || node.y !== origin.y);
  }

  function layout(nodes) {
    const missing = nodes.filter(n => !fin(n.x) || !fin(n.y));
    if (!missing.length) return;
    const placed = nodes.filter(n => !missing.includes(n));
    const top = placed.length ? Math.max.apply(null, placed.map(n => n.y)) + 150 : 120;
    const left = placed.length ? Math.min.apply(null, placed.map(n => n.x)) : 20;
    missing.forEach((n, i) => {
      n.x = left + (i % 5) * 170;
      n.y = top + Math.floor(i / 5) * 150;
    });
  }

  const isOwn = (o, k) => Object.hasOwn(o, k);
  // Names inherited from Object.prototype must never be treated as catalog
  // keys or assigned as fields: they are what makes "constructor" a ghost node.
  const isProtoName = k => typeof k === 'string' && (k === '__proto__' || k in Object.prototype);

  function validate(raw, catalog) {
    const issues = [];
    let dropped = 0; // genuinely unusable nodes/edges; writers reject these
    const types = (catalog && catalog.types) || {};
    const ranges = (catalog && catalog.ranges) || {};
    const enums = (catalog && catalog.enums) || {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { scenario: null, error: 'Scenario: expected a JSON object', dropped: 1 };
    }

    const scenario = {
      version: VERSION,
      name: 'Untitled scenario',
      nodes: /** @type {any[]} */ ([]),
      edges: /** @type {any[]} */ ([])
    };
    // Unknown root fields are kept as-is so an edit never deletes them.
    Object.keys(raw).forEach(k => {
      if (ROOT_KEYS.indexOf(k) >= 0) return;
      if (isProtoName(k)) { issues.push('unsafe field "' + k + '"'); dropped++; return; }
      issues.push('unknown field "' + k + '" (kept as-is)');
      scenario[k] = raw[k];
    });
    if (raw.version !== undefined && raw.version !== VERSION) {
      issues.push('version ' + raw.version + ' is not supported, using ' + VERSION);
    }
    if (typeof raw.name === 'string' && raw.name.trim()) scenario.name = raw.name;

    const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
    if (raw.nodes !== undefined && !Array.isArray(raw.nodes)) { issues.push('"nodes" is not an array'); dropped++; }

    // Reserve every explicit id before generating any, so a node without an id
    // can never take the id of a node that appears later in the file.
    const reserved = new Set();
    rawNodes.forEach(rn => {
      if (rn && typeof rn === 'object' && !Array.isArray(rn) && typeof rn.id === 'string' && rn.id) reserved.add(rn.id);
    });
    const ids = new Set();
    const genId = i => {
      let n = i + 1;
      let id = 'n' + n;
      while (reserved.has(id) || ids.has(id)) { n++; id = 'n' + n; }
      return id;
    };

    const nodes = [];
    rawNodes.forEach((rn, i) => {
      if (!rn || typeof rn !== 'object' || Array.isArray(rn)) {
        issues.push('nodes[' + i + '] is not an object');
        dropped++;
        return;
      }
      let type = rn.type;
      const legacyModel = type === 'workers_ai' && rn.p &&
        (Object.hasOwn(rn.p, 'inPrice') || Object.hasOwn(rn.p, 'outPrice'));
      if (legacyModel) type = 'external_model';
      if (typeof type !== 'string' || !isOwn(types, type)) {
        if (typeof type === 'string' && !isProtoName(type)) {
          // Genuine unknown type: keep the raw node verbatim, render nothing.
          const opaque = {};
          Object.keys(rn).forEach(k => {
            if (isProtoName(k)) { issues.push('unsafe field "' + k + '" on nodes[' + i + ']'); dropped++; return; }
            opaque[k] = rn[k];
          });
          if (typeof opaque.id === 'string' && opaque.id && !ids.has(opaque.id)) ids.add(opaque.id);
          issues.push('unknown node type "' + type + '" at nodes[' + i + '] (kept as-is)');
          nodes.push(opaque);
          return;
        }
        // Prototype names (constructor, __proto__, toString, ...) are rejected.
        issues.push('unknown node type "' + type + '" at nodes[' + i + ']');
        dropped++;
        return;
      }

      const def = types[type];
      let id = typeof rn.id === 'string' && rn.id ? rn.id : null;
      if (!id) {
        id = genId(i);
        issues.push('missing id at nodes[' + i + '], using "' + id + '"');
      } else if (ids.has(id)) {
        const dup = id;
        id = genId(i);
        issues.push('duplicate id "' + dup + '" at nodes[' + i + '], using "' + id + '"');
        dropped++;
      }
      ids.add(id);

      const p = {};
      Object.keys(def.p || {}).forEach(k => { p[k] = def.p[k]; });
      if (rn.p !== undefined && (typeof rn.p !== 'object' || rn.p === null || Array.isArray(rn.p))) {
        issues.push('"p" is not an object on node "' + id + '"');
        dropped++;
      } else if (rn.p) {
        Object.keys(rn.p).forEach(k => {
          if (isProtoName(k)) { issues.push('unsafe param "' + k + '" on node "' + id + '"'); dropped++; return; }
          const v = rn.p[k];
          if (!isOwn(def.p || {}, k)) {
            // Unknown params ride along in p so an edit cannot delete them.
            issues.push('unknown param "' + k + '" on node "' + id + '" (kept as-is)');
            p[k] = v;
            return;
          }
          // A param whose catalog default is null is "unset" and accepts null
          // (the external model token prices); every other param stays numeric.
          const nullable = v === null && def.p[k] === null;
          if (nullable) { p[k] = null; return; }
          if (enums[k]) {
            if (!enums[k].includes(v)) {
              issues.push('invalid value for "' + k + '" on node "' + id + '"');
              dropped++;
              return;
            }
            p[k] = v;
            return;
          }
          if (!fin(v)) {
            issues.push('invalid value for "' + k + '" on node "' + id + '"');
            dropped++;
            return;
          }
          if (def.source && k === 'concurrency' && v === 0) {
            issues.push('legacy source concurrency 0 on node "' + id + '" normalized to 1');
            p[k] = 1;
            return;
          }
          const range = ranges[k];
          if (range) {
            const lo = range[0], hi = range[1];
            if (v < lo || v > hi) {
              const clamped = v < lo ? lo : hi;
              issues.push('"' + k + '" on node "' + id + '" is outside [' + lo + ', ' + hi + '], using ' + clamped);
              dropped++;
              p[k] = clamped;
              return;
            }
          }
          p[k] = v;
        });
      }

      let alias = null;
      if (rn.alias !== undefined) {
        if (typeof rn.alias !== 'string') {
          issues.push('invalid alias on node "' + id + '"');
          dropped++;
        } else if (rn.alias.length > MAX_ALIAS) {
          issues.push('alias on node "' + id + '" is longer than ' + MAX_ALIAS + ' characters, dropped');
          dropped++;
        } else if (CONTROL.test(rn.alias)) {
          issues.push('alias on node "' + id + '" contains control characters, dropped');
          dropped++;
        } else if (rn.alias.trim()) {
          alias = rn.alias;
        }
      }

      const n = { id: id, type: type };
      if (fin(rn.x)) n.x = rn.x;
      if (fin(rn.y)) n.y = rn.y;
      if (alias) n.alias = alias;
      n.p = p;
      Object.keys(rn).forEach(k => {
        if (NODE_KEYS.indexOf(k) >= 0) return;
        if (isProtoName(k)) { issues.push('unsafe field "' + k + '" on nodes[' + i + ']'); dropped++; return; }
        issues.push('unknown field "' + k + '" on nodes[' + i + '] (kept as-is)');
        n[k] = rn[k];
      });
      nodes.push(n);
    });
    layout(nodes.filter(n => isOwn(types, n.type)));

    const edges = [];
    if (raw.edges !== undefined && !Array.isArray(raw.edges)) { issues.push('"edges" is not an array'); dropped++; }
    (Array.isArray(raw.edges) ? raw.edges : []).forEach((re, i) => {
      if (!re || typeof re !== 'object' || Array.isArray(re)) {
        issues.push('edges[' + i + '] is not an object');
        dropped++;
        return;
      }
      if (typeof re.from !== 'string' || typeof re.to !== 'string' || !ids.has(re.from) || !ids.has(re.to)) {
        issues.push('edges[' + i + '] does not connect two known nodes');
        dropped++;
        return;
      }
      const e = { from: re.from, to: re.to };
      if (re.weight !== undefined) {
        if (!fin(re.weight)) { issues.push('invalid weight on edges[' + i + ']'); dropped++; }
        else if (re.weight < 0) { issues.push('weight on edges[' + i + '] is negative, using 0'); dropped++; e.weight = 0; }
        else e.weight = re.weight;
      }
      Object.keys(re).forEach(k => {
        if (EDGE_KEYS.indexOf(k) >= 0) return;
        if (isProtoName(k)) { issues.push('unsafe field "' + k + '" on edges[' + i + ']'); dropped++; return; }
        issues.push('unknown field "' + k + '" on edges[' + i + '] (kept as-is)');
        e[k] = re[k];
      });
      edges.push(e);
    });

    scenario.nodes = nodes;
    scenario.edges = edges;
    return {
      scenario: scenario,
      error: issues.length ? 'Scenario: ' + issues.join('; ') : null,
      dropped: dropped
    };
  }

  // First free palette id: every numeric node id, opaque ones included, is taken.
  function nextNodeSeq(nodes) {
    let seq = 1;
    (nodes || []).forEach(n => {
      const m = n && typeof n.id === 'string' ? /^n(\d+)$/.exec(n.id) : null;
      if (m) seq = Math.max(seq, parseInt(m[1], 10) + 1);
    });
    return seq;
  }

  // A stored opaque node whose id is reused can only be merged when all of its
  // data survives: an opaque node of another type loses its type, and a known
  // node with no p object cannot hold its params. Return a descriptor so the
  // server can reject with both types named instead of silently dropping data.
  function mergeConflict(incoming, stored, catalog) {
    if (!stored || !incoming || !Array.isArray(incoming.nodes) || !Array.isArray(stored.nodes)) return null;
    const types = (catalog && catalog.types) || {};
    const isKnown = n => isOwn(types, n.type);
    const byId = new Map();
    incoming.nodes.forEach(n => { if (n && typeof n.id === 'string') byId.set(n.id, n); });
    for (const sn of stored.nodes) {
      if (!sn || isKnown(sn)) continue;
      const id = typeof sn.id === 'string' ? sn.id : null;
      if (!id || !byId.has(id)) continue;
      const same = byId.get(id);
      if (!isKnown(same)) {
        // Both opaque: the stored type cannot be attached to a node of a
        // different unknown type, so reusing the id would drop it.
        if (same.type !== sn.type) return { id: id, storedType: sn.type, incomingType: same.type };
        continue;
      }
      const p = sn.p;
      const hasParams = p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length > 0;
      const canHold = same.p && typeof same.p === 'object' && !Array.isArray(same.p);
      if (hasParams && !canHold) return { id: id, storedType: sn.type, incomingType: same.type };
    }
    return null;
  }

  // Merge the stored unknown data into an incoming scenario before a write:
  // stored opaque nodes come back, and unknown root/param/node/edge fields are
  // re-added when the incoming payload omits them. Known nodes stay removable.
  function merge(incoming, stored, catalog) {
    if (!stored) return incoming;
    const types = (catalog && catalog.types) || {};
    const isKnown = n => isOwn(types, n.type);
    const byId = new Map();
    incoming.nodes.forEach(n => { if (typeof n.id === 'string') byId.set(n.id, n); });

    Object.keys(stored).forEach(k => {
      if (ROOT_KEYS.indexOf(k) >= 0) return;
      if (!isOwn(incoming, k)) incoming[k] = stored[k];
    });

    const opaqueJson = new Set(incoming.nodes.filter(n => !isKnown(n)).map(n => JSON.stringify(n)));
    stored.nodes.forEach(sn => {
      const id = typeof sn.id === 'string' ? sn.id : null;
      if (!isKnown(sn)) {
        const same = id ? byId.get(id) : null;
        if (same) {
          if (!isKnown(same)) {
            // Partial opaque node: complete it from the stored copy.
            Object.keys(sn).forEach(k => { if (!isOwn(same, k)) same[k] = sn[k]; });
          } else {
            // Known node reusing a stored opaque id: keep the incoming identity
            // and type, but preserve the opaque node's unknown fields/params.
            Object.keys(sn).forEach(k => {
              if (NODE_KEYS.indexOf(k) >= 0) return;
              if (!isOwn(same, k)) same[k] = sn[k];
            });
            if (same.p && typeof same.p === 'object' && !Array.isArray(same.p) &&
                sn.p && typeof sn.p === 'object' && !Array.isArray(sn.p)) {
              const allowed = types[same.type].p || {};
              Object.keys(sn.p).forEach(k => {
                if (isOwn(allowed, k)) return; // a known catalog param is not an extra
                if (!isOwn(same.p, k)) same.p[k] = sn.p[k];
              });
            }
          }
          return;
        }
        if (!id && opaqueJson.has(JSON.stringify(sn))) return;
        incoming.nodes.push(sn);
        if (id) byId.set(id, sn);
        opaqueJson.add(JSON.stringify(sn));
        return;
      }
      const target = byId.get(sn.id);
      if (!target) return; // removing a known node stays possible
      Object.keys(sn).forEach(k => {
        if (NODE_KEYS.indexOf(k) >= 0) return;
        if (!isOwn(target, k)) target[k] = sn[k];
      });
      if (target.p && sn.p) {
        const allowed = types[sn.type].p || {};
        Object.keys(sn.p).forEach(k => {
          if (isOwn(allowed, k)) return;
          if (!isOwn(target.p, k)) target.p[k] = sn.p[k];
        });
      }
    });

    const edgeKey = e => e.from + '\u0000' + e.to;
    const incomingEdges = new Map();
    incoming.edges.forEach(e => { if (!incomingEdges.has(edgeKey(e))) incomingEdges.set(edgeKey(e), e); });
    const mergedIds = new Set(incoming.nodes.map(n => n.id));
    const opaqueIds = new Set(incoming.nodes.filter(n => !isKnown(n) && typeof n.id === 'string').map(n => n.id));
    stored.edges.forEach(se => {
      const target = incomingEdges.get(edgeKey(se));
      if (!target) {
        // An edge that only exists because of a preserved opaque node stays,
        // as long as the other endpoint was not deliberately removed.
        if ((opaqueIds.has(se.from) || opaqueIds.has(se.to)) && mergedIds.has(se.from) && mergedIds.has(se.to)) {
          incoming.edges.push(se);
          incomingEdges.set(edgeKey(se), se);
        }
        return;
      }
      Object.keys(se).forEach(k => {
        if (EDGE_KEYS.indexOf(k) >= 0) return;
        if (!isOwn(target, k)) target[k] = se[k];
      });
    });
    return incoming;
  }

  function toB64Url(bytes) {
    let b64;
    if (typeof Buffer !== 'undefined') b64 = Buffer.from(bytes).toString('base64');
    else {
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      b64 = btoa(s);
    }
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromB64Url(text) {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function encode(scenario) {
    const text = toB64Url(new TextEncoder().encode(JSON.stringify(scenario)));
    return text.length > MAX_HASH ? null : text;
  }

  function decode(text) {
    if (typeof text !== 'string') return null;
    const body = text.replace(/^#s=/, '');
    if (!body || body.length > MAX_HASH) return null;
    try {
      return JSON.parse(new TextDecoder().decode(fromB64Url(body)));
    } catch (e) {
      return null;
    }
  }

  return {
    VERSION: VERSION, MAX_HASH: MAX_HASH, MAX_ALIAS: MAX_ALIAS,
    validate: validate, layout: layout, moved: moved, nextNodeSeq: nextNodeSeq,
    merge: merge, mergeConflict: mergeConflict, encode: encode, decode: decode
  };
});
