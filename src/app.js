(function () {
  const TYPES = window.CATALOG.types;
  const GROUPS = window.CATALOG.groups;
  const QE = window.QUEUE_ENGINE;
  const UX = window.UX;
  const NS = 'http://www.w3.org/2000/svg';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = v => String(v).replace(/[&<>"']/g, c => ESC[c]);
  const cloneJson = value => JSON.parse(JSON.stringify(value));
  const NODE_KEYS = ['id', 'type', 'x', 'y', 'alias', 'p'];
  const EDGE_KEYS = ['from', 'to', 'weight'];
  // ponytail: the engine models rates, not people. One visible assumption turns
  // the first monthly limit into a user estimate; surfaced in the tooltip.
  const REQ_PER_USER_PER_MONTH = 100;
  const ROOT_KEYS = ['version', 'name', 'nodes', 'edges'];
  const hasType = n => Object.hasOwn(TYPES, n.type);

  let runSeq = 0;
  function nextRunId() { return 'run-' + String(++runSeq).padStart(6, '0'); }

  const state = {
    nodes: [], opaque: [], rootExtra: {}, edges: [], sel: null, zoom: 1, px: 40, py: 40, name: 'Untitled scenario',
    running: false, speed: 60, budget: 5000, plan: 'paid', baseFee: 0, edgeEls: [], cpuRate: 0,
    time: 0, spent: 0, requests: 0, modelSpent: 0, chaos: {}, errors: 0,
    res: {}, rate: 0, pathLat: 0, backlog: {}, drops: {},
    runId: nextRunId(), scenarioRevision: null, scenarioHash: null, dirty: false, saving: false, saveError: null
  };
  let seq = 1;
  const uid = () => 'n' + seq++;

  function typeOf(n) { return TYPES[n.type]; }
  function groupColor(t) { return (GROUPS.find(g => g.id === TYPES[t].group) || {}).color || '#888'; }

  function addNode(type, x, y) {
    const def = TYPES[type];
    const node = { id: uid(), type, x, y, p: Object.assign({}, def.p) };
    state.nodes.push(node);
    return node;
  }

  function addEdge(from, to) {
    if (from === to) return null;
    if (state.edges.some(e => e.from === from && e.to === to)) return null;
    const e = { from, to };
    state.edges.push(e);
    return e;
  }

  function nodeById(id) { return state.nodes.find(n => n.id === id); }

  function eff(n, clock) {
    const current = clock || state;
    let p = Object.assign({}, n.p);
    const now = current.time;
    let slashed = false;
    const modelHit = QE.model429(n.type, p, current.chaos.model429 > now);
    if (modelHit.slashed) { p = modelHit.p; slashed = true; }
    if (n.type === 'durable_objects' && current.chaos.doEvict > now) {
      p.latency *= 8; slashed = true;
    }
    if (n.type === 'd1' && current.chaos.d1Write > now) {
      p.latency *= 20; slashed = true;
    }
    if (n.type === 'cache' && current.chaos.cacheStorm > now) {
      p.hit = 0; slashed = true;
    }
    if (n.type === 'external' && current.chaos.store402 > now) {
      p.latency *= 100; slashed = true;
    }
    if (n.type === 'queues' && current.chaos.webhook > now) {
      p.latency *= 2; slashed = true;
    }
    return { p, slashed };
  }

  function modelFor(nodes, edges, backlog, drops, clock) {
    const current = clock || state;
    const params = {};
    nodes.forEach(n => { params[n.id] = eff(n, current).p; });
    const model = QE.compute(nodes, edges, TYPES, params, backlog, drops, PRICING.hoursPerMonth);
    nodes.forEach(n => {
      if (n.type === 'external' && current.chaos.store402 > current.time) model.res[n.id].err = 1;
    });
    return model;
  }

  function applyModel(model) {
    state.res = model.res;
    state.cpuRate = model.cpuRate;
    state.rate = model.rate;
    state.pathLat = model.pathLat;
  }

  function compute() {
    applyModel(modelFor(state.nodes, state.edges, state.backlog, state.drops));
  }

  function addFromPalette(type) {
    const rect = $('#canvas').getBoundingClientRect();
    const gx = (rect.width / 2 - state.px) / state.zoom;
    const gy = (rect.height / 2 - state.py) / state.zoom;
    const n = addNode(type, gx - 37, gy - 37);
    compute();
    select(n.id);
    render();
    pushScenario();
    return n;
  }

  function renderPalette() {
    const q = ($('#search').value || '').toLowerCase();
    const wrap = $('#palette-list');
    wrap.innerHTML = '';
    let shown = 0;
    GROUPS.forEach(g => {
      const items = Object.keys(TYPES).filter(k => TYPES[k].group === g.id && TYPES[k].name.toLowerCase().includes(q));
      if (!items.length) return;
      shown += items.length;
      const sec = document.createElement('div');
      sec.className = 'pal-group';
      sec.innerHTML = '<div class="pal-title">' + g.label + '</div>';
      const grid = document.createElement('div');
      grid.className = 'pal-grid';
      items.forEach(k => {
        const def = TYPES[k];
        const el = document.createElement('button');
        el.className = 'pal-item';
        el.title = def.note || def.name;
        el.innerHTML = '<span class="pal-ico" style="color:' + groupColor(k) + '">' + svg(k) + '</span><span>' + def.name + '</span>';
        el.addEventListener('pointerdown', ev => {
          ev.preventDefault();
          ev.stopPropagation();
          const n = addFromPalette(k);
          drag = { id: n.id, sx: ev.clientX, sy: ev.clientY, ox: n.x, oy: n.y };
        });
        el.addEventListener('keydown', ev => {
          if (ev.key !== 'Enter' && ev.key !== ' ') return;
          ev.preventDefault();
          addFromPalette(k);
        });
        grid.appendChild(el);
      });
      sec.appendChild(grid);
      wrap.appendChild(sec);
    });
    if (!shown) wrap.innerHTML = '<div class="pal-empty">No components match.</div>';
  }

  function svg(type) {
    const def = TYPES[type];
    const inner = (window.ICONS && window.ICONS[def.icon]) || '';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }

  function render() {
    const world = $('#world');
    world.style.transform = 'translate(' + state.px + 'px,' + state.py + 'px) scale(' + state.zoom + ')';
    $('#zoomlabel').textContent = Math.round(state.zoom * 100) + '%';
    renderName();
    buildEdges();
    renderNodes();
    renderInspector();
    renderCost();
    renderAlerts();
  }

  function renderName() {
    const el = $('#scenario-name');
    if (!el) return;
    const tagline = 'model of real Cloudflare behaviour \u2014 not a load test';
    const text = state.name && state.name !== 'Untitled scenario' ? state.name : tagline;
    if (el.textContent !== text) el.textContent = text;
    if (document.title.indexOf(text) !== 0) document.title = text + ' \u2014 Cloudflare architecture simulator';
  }

  function samplePath(path, len) {
    const n = 48, pts = [];
    for (let i = 0; i <= n; i++) {
      const at = (i / n) * len;
      const p = path.getPointAtLength(at);
      pts.push({ x: p.x, y: p.y, l: at });
    }
    return pts;
  }

  function pointOn(e, pos) {
    const pts = e.pts;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].l <= pos) lo = mid; else hi = mid;
    }
    const a = pts[lo], b = pts[hi];
    const f = b.l === a.l ? 0 : (pos - a.l) / (b.l - a.l);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }

  function buildEdges() {
    const g = $('#edge-layer');
    g.innerHTML = '';
    state.edgeEls = [];
    state.edges.forEach(e => {
      const a = nodeById(e.from), b = nodeById(e.to);
      if (!a || !b) return;
      const x1 = a.x + 74, y1 = a.y + 37, x2 = b.x, y2 = b.y + 37;
      const d = 'M' + x1 + ',' + y1 + ' C' + (x1 + 46) + ',' + y1 + ' ' + (x2 - 46) + ',' + y2 + ' ' + x2 + ',' + y2;
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', 'edge');
      g.appendChild(path);
      const len = path.getTotalLength();
      const pool = Math.min(64, Math.max(8, Math.ceil(len / 4) + 2));
      const dots = [];
      for (let i = 0; i < pool; i++) {
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('r', 2.2);
        c.setAttribute('class', 'bead');
        c.style.opacity = 0;
        g.appendChild(c);
        dots.push({ el: c });
      }
      state.edgeEls.push({ path, dots, len, pts: samplePath(path, len), from: e.from, to: e.to });
    });
  }

  function animateEdges(ts) {
    const t = ts / 1000;
    (state.edgeEls || []).forEach(e => {
      // ponytail: the from-node rate stands in for the edge's own share;
      // per-edge weights (roadmap) will replace it with the edge share.
      const fr = state.res[e.from] || {};
      const flow = fr.out || 0;
      const r = state.res[e.to] || {};
      const hot = flow > 0 && ((r.util || 0) >= 0.9 || (r.err || 0) > 0);
      const cls = 'edge' + (hot ? ' hot' : '') + (flow <= 0 ? ' idle' : '');
      if (e.path.getAttribute('class') !== cls) e.path.setAttribute('class', cls);
      if (!state.running || flow <= 0 || e.len <= 0) {
        e.dots.forEach(d => { if (d.el.style.opacity !== '0') d.el.style.opacity = 0; });
        return;
      }
      const rate = Math.min(50, flow);
      let speed = 90 + Math.min(180, flow * 2.2);
      if (speed / rate > e.len) speed = rate * e.len;
      const spacing = speed / rate;
      const n = Math.min(e.dots.length, Math.floor(e.len / spacing) + 1);
      for (let i = 0; i < e.dots.length; i++) {
        const d = e.dots[i];
        if (i >= n) { d.el.style.opacity = 0; continue; }
        const pos = (t * speed + i * spacing) % e.len;
        const pt = pointOn(e, pos);
        const j = hot ? (Math.random() - 0.5) * 2.4 : 0;
        d.el.setAttribute('cx', pt.x + j);
        d.el.setAttribute('cy', pt.y + j);
        d.el.setAttribute('r', hot ? 2.6 : 2.2);
        d.el.setAttribute('class', 'bead' + (hot ? ' hot' : ''));
        d.el.style.opacity = 0.95;
      }
    });
  }

  function renderNodes() {
    const layer = $('#node-layer');
    const focused = document.activeElement && document.activeElement.closest('.node');
    const focusId = focused ? focused.dataset.id : null;
    layer.innerHTML = '';
    state.nodes.forEach(n => {
      const def = typeOf(n);
      const r = state.res[n.id] || { lambda: 0, util: 0, err: 0, lat: 0, cost: 0 };
      const { slashed } = eff(n);
      const util = r.util || 0;
      const pct = Math.round(util * 100);
      const bad = (r.err || 0) > 0 || util >= 1;
      const cls = bad ? 'hot' : util > 0.9 ? 'hot' : util > 0.7 ? 'warm' : '';
      const barCls = (r.err || 0) > 0 ? 'over' : util >= 1 ? 'over' : util > 0.9 ? 'hot' : util > 0.7 ? 'warm' : '';
      const bcls = (r.err || 0) > 0 ? 'bad' : util >= 1 ? 'bad' : util > 0.7 ? 'warn' : '';
      const el = document.createElement('div');
      el.className = 'node' + (state.sel === n.id ? ' sel' : '') + (slashed ? ' hit' : '') + (bad ? ' sat' : '');
      el.dataset.id = n.id;
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', nname(n) + '. ' + badge(n, r) + '. Press Enter to select, Delete to remove.');
      el.style.left = n.x + 'px';
      el.style.top = n.y + 'px';
      const color = groupColor(n.type);
      el.innerHTML =
        '<div class="nbox ' + cls + '" style="--c:' + color + '">' +
          '<span class="nicon">' + svg(n.type) + '</span>' +
          (def.source ? '<span class="nrate">' + Math.round(r.lambda) + '/s</span>' : '') +
          '<span class="nbar"><i class="' + barCls + '" style="width:' + Math.min(100, pct) + '%"></i></span>' +
        '</div>' +
        '<div class="nlabel">' + esc(n.alias || def.name) + '</div>' +
        '<div class="nbadge ' + bcls + '">' + badge(n, r) + '</div>' +
        '<span class="port" data-port="1"></span>';
      layer.appendChild(el);
    });
    $$('.node').forEach(el => {
      el.addEventListener('pointerdown', onNodeDown);
      el.addEventListener('keydown', ev => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        select(el.dataset.id, true);
      });
    });
    $$('.port').forEach(p => { p.addEventListener('pointerdown', onPortDown); });
    if (focusId) {
      const next = Array.from(layer.children).find(el => el.dataset.id === focusId);
      if (next) next.focus({ preventScroll: true });
    }
  }

  function badge(n, r) {
    if (typeOf(n).source) return Math.round(r.lambda || 0) + '/s in';
    if (!r || !r.lambda) return 'idle';
    const pct = Math.round((r.util || 0) * 100);
    if (n.type === 'queues' && (r.drops || 0) > 0) return 'EXPIRY ' + (r.drops || 0).toFixed(1) + '/s';
    if (n.type === 'queues' && (r.backlog || 0) > 0) return 'BACKLOG ' + Math.round(r.backlog).toLocaleString();
    if (n.type === 'durable_objects' && r.overloaded) return 'OVERLOADED ' + pct + '%';
    if ((r.err || 0) > 0) return 'ERR ' + Math.round(r.err * 100) + '%';
    if (r.util >= 1) return 'SATURATED ' + pct + '%';
    if (r.util > 0.9) return 'LOAD ' + pct + '%';
    return 'LOAD ' + pct + '% \u00b7 ' + r.lambda.toFixed(1) + '/s';
  }

  function nname(n) { return n.alias || typeOf(n).name; }

  function renderAlerts() {
    const rows = state.nodes.map(n => ({ n, r: state.res[n.id] || {} }));
    const out = [];
    const over = rows.filter(x => (x.r.util || 0) >= 1.15).sort((a, b) => b.r.util - a.r.util)[0];
    const errs = rows.filter(x => (x.r.err || 0) > 0 && x.n.type !== 'external');
    const drops = rows.filter(x => (x.r.err || 0) > 0 && x.n.type === 'external').length;
    const spof = rows.filter(x => {
      const p = eff(x.n).p;
      return x.r.lambda > 0 && p.concurrency === 1 && (x.r.util || 0) >= 0.55 && x.n.type !== 'external';
    })[0];
    if (over) out.push({ t: 'HOT PATH BOTTLENECK \u00b7 ' + esc(nname(over.n)), c: 'crit' });
    if (errs.length) out.push({ t: 'ERROR BUDGET BURN', c: 'warn' });
    if (drops) out.push({ t: 'DATA LOSS RISK \u00b7 sync drops', c: 'warn' });
    const qDrops = rows.filter(x => x.n.type === 'queues' && (state.drops[x.n.id] || 0) > 0);
    const qBacklog = rows.filter(x => x.n.type === 'queues' && (state.backlog[x.n.id] || 0) > 0 && !qDrops.includes(x));
    if (qDrops.length) out.push({ t: 'QUEUE EXPIRY \u00b7 messages dropped', c: 'warn' });
    else if (qBacklog.length) out.push({ t: 'QUEUE BACKLOG \u00b7 ' + esc(nname(qBacklog[0].n)), c: 'warn' });
    if (spof && out.length < 4) out.push({ t: 'SPOF \u00b7 ' + esc(nname(spof.n)), c: 'warn' });
    const html = out.slice(0, 4).map(a => '<span class="alert ' + a.c + '">' + a.t + '</span>').join('');
    const box = $('#alerts');
    if (box.innerHTML !== html) box.innerHTML = html;
  }

  function statsHtml(r, n) {
    let html = '<div><span>in</span><b>' + (r.lambda ? r.lambda.toFixed(1) + '/s' : '\u2014') + '</b></div>' +
      '<div><span>util</span><b>' + (r.util ? Math.round(r.util * 100) + '%' : '\u2014') + '</b></div>' +
      '<div><span>errors</span><b>' + (r.err ? Math.round(r.err * 100) + '%' : '0%') + '</b></div>' +
      '<div><span>latency</span><b>' + (r.lat ? fmt(r.lat * 1000) : '\u2014') + '</b></div>' +
      '<div><span>cost/h</span><b>' + (r.cost ? '$' + (r.cost * 3600).toFixed(2) : '$0') + '</b></div>';
    if (n && n.type === 'queues') {
      const b = r.backlog || 0;
      html += '<div><span>capacity</span><b>' + (r.capacity ? r.capacity.toFixed(1) + '/s' : '0/s') + '</b></div>' +
        '<div><span>backlog</span><b>' + (b ? Math.round(b).toLocaleString() : '0') + '</b></div>' +
        '<div><span>drops</span><b>' + ((r.drops || 0) ? r.drops.toFixed(1) + '/s' : '0/s') + '</b></div>';
    }
    if (n && n.type === 'durable_objects') {
      html += '<div><span>objects</span><b>' + (r.objects || 0) + '</b></div>' +
        '<div><span>req/object</span><b>' + (r.perObjectRate || 0).toFixed(1) + '/s</b></div>' +
        '<div><span>billed req</span><b>' + (r.billedRequests || 0).toFixed(1) + '/s</b></div>';
    }
    return html;
  }

  function renderInspectorStats() {
    const el = $('#ins-stats');
    if (!el || !state.sel) return;
    const n = nodeById(state.sel);
    el.innerHTML = statsHtml(state.res[state.sel] || {}, n);
  }

  function renderInspector() {
    const box = $('#inspect');
    if (!state.sel) {
      box.innerHTML = '<div class="empty">Select a node to edit it.<br><br>Keyboard: Tab to a node, press Enter or Space to select it, and press Delete to remove it. Use Connect to in the inspector to add an edge without dragging.</div>';
      return;
    }
    const n = nodeById(state.sel);
    if (!n) return;
    const def = typeOf(n);
    const r = state.res[n.id] || {};
    const fields = def.fields || ['concurrency', 'latency', 'price'];
    const labels = {
      rate: 'Requests / s',
      concurrency: 'Concurrency',
      latency: 'Service time (ms)',
      retention: 'Retention (s)',
      price: '$ per million units',
      units: 'Units per request',
      hit: 'Cache hit %',
      priceGBs: '$ per M GB-s',
      cpuMs: 'CPU ms / request',
      objects: 'Object count',
      transport: 'Transport',
      connections: 'WebSocket connections / s',
      activePct: 'Connected / active window %',
      activeMs: 'Active ms / incoming message',
      activeSeconds: 'Active wall-clock seconds / month',
      rowsRead: 'SQLite rows read / request',
      rowsWritten: 'SQLite rows written / request',
      storedGb: 'SQLite stored GB (total)',
      classAUnits: 'Class A units / request',
      storageGb: 'Stored GB',
      priceClassA: '$ per million Class A units',
      priceStorage: '$ per GB-month',
      pricePerThousand: '$ per 1,000 transforms',
      priceStored: '$ per 100,000 stored images',
      priceDelivered: '$ per 100,000 delivered images',
      storagePrice: '$ per 1,000 stored minutes',
      deliveryPricePerThousand: '$ per 1,000 delivered minutes',
      uniqueTransforms: 'Unique transforms / month',
      imagesStored: 'Images stored / month',
      imagesDelivered: 'Images delivered / month',
      minutesStored: 'Video minutes stored',
      minutesDelivered: 'Video minutes delivered',
      neuronsIn: 'Neurons / 1M input tokens',
      neuronsOut: 'Neurons / 1M output tokens',
      inPrice: 'Input $ / 1M tokens',
      outPrice: 'Output $ / 1M tokens',
      inTokens: 'Input tokens / request',
      outTokens: 'Output tokens / request'
    };
    const RANGES = window.CATALOG.ranges || {};
    const ENUMS = window.CATALOG.enums || {};
    let html = '<div class="ins-head"><span class="dot" style="background:' + groupColor(n.type) + '"></span><b>' + esc(n.alias || def.name) + '</b></div>';
    if (def.verified) {
      html += '<div class="provenance verified"><b>Verified prices &amp; limits</b>' + def.verified + '</div>';
    } else {
      html += '<div class="provenance assumption"><b>Editable assumptions</b>No verified price or limit is provided for this component. Workload and price fields below are editable assumptions.</div>';
    }
    html += '<div class="field-group-title">Editable assumptions</div>';
    fields.forEach(f => {
      const L = labels[f] || f;
      const provenance = UX.fieldProvenance(def, f);
      const head = '<div class="field-head"><span>' + L + '</span><span class="prov-badge ' + provenance.kind + '">' + provenance.label + '</span></div>';
      if (ENUMS[f]) {
        html += '<label class="field">' + head + '<select data-f="' + f + '">' +
          ENUMS[f].map(v => '<option value="' + v + '"' + (n.p[f] === v ? ' selected' : '') + '>' + v + '</option>').join('') +
          '</select></label>';
        return;
      }
      const R = RANGES[f] || [0, 1e6, 1];
      html += '<label class="field">' + head + '<input type="number" data-f="' + f + '" min="' + R[0] + '" max="' + R[1] + '" step="' + R[2] + '" value="' + (n.p[f] == null ? '' : n.p[f]) + '"></label>';
    });
    html += '<div class="ins-stats" id="ins-stats">' + statsHtml(r, n) + '</div>';
    if (def.note) html += '<p class="note">' + def.note + '</p>';
    if (def.doc) html += '<a class="src" target="_blank" rel="noopener" href="' + def.doc + '">Source</a>';
    const targets = UX.connectTargets(state.nodes, n.id);
    if (targets.length) {
      html += '<div class="connect"><label class="field"><span>Connect to</span><select id="connect-target">' +
        targets.map(t => '<option value="' + esc(t.id) + '">' + esc(t.label) + '</option>').join('') +
        '</select></label><button id="connect-node">Connect</button></div>';
    }
    html += '<button class="del" id="delnode">Delete node</button>';
    box.innerHTML = html;
    $$('select[data-f]', box).forEach(sel => {
      sel.addEventListener('change', () => {
        n.p[sel.dataset.f] = sel.value;
        compute(); renderNodes(); renderCost(); renderInspectorStats();
        pushScenario();
      });
    });
    $$('input[data-f]', box).forEach(inp => {
      inp.addEventListener('input', () => {
        const f = inp.dataset.f;
        const nullable = f === 'inPrice' || f === 'outPrice' || f === 'inTokens' || f === 'outTokens';
        if (inp.value.trim() === '') {
          if (nullable) { n.p[f] = null; compute(); renderNodes(); renderCost(); renderInspectorStats(); pushScenario(); }
          return;
        }
        const raw = parseFloat(inp.value);
        if (isNaN(raw)) return;
        const lo = parseFloat(inp.min), hi = parseFloat(inp.max);
        n.p[f] = Math.min(hi, Math.max(lo, raw));
        compute(); renderNodes(); renderCost(); renderInspectorStats();
        pushScenario();
      });
      inp.addEventListener('change', () => { inp.value = n.p[inp.dataset.f] == null ? '' : n.p[inp.dataset.f]; });
    });
    $('#delnode').addEventListener('click', () => deleteSelected());
    if ($('#connect-node')) {
      $('#connect-node').addEventListener('click', () => {
        const to = $('#connect-target').value;
        if (addEdge(n.id, to)) {
          compute(); renderNodes(); renderCost(); renderInspectorStats(); pushScenario();
          toast('Connected to ' + nname(nodeById(to)));
        } else {
          toast('Those components are already connected');
        }
      });
    }
  }

  function fmt(v) { return v < 1000 ? Math.round(v) + 'ms' : (v / 1000).toFixed(1) + 's'; }

  function money(v) {
    if (!(v > 0)) return '$0.00';
    if (v < 0.01) return '$' + v.toFixed(4);
    return '$' + v.toFixed(2);
  }

  function pctText(v) { return v > 0 && v < 10 ? v.toFixed(1) : String(Math.round(v)); }

  function human(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return Math.round(n) + '';
  }

  function perReq(v) {
    if (!(v > 0)) return '$0';
    if (v < 0.0001) return '$' + v.toExponential(2);
    if (v < 0.01) return '$' + v.toFixed(6);
    return '$' + v.toFixed(4);
  }

  function sourceRate() {
    return state.nodes.reduce((s, n) => s + (typeOf(n).source ? (n.p.rate || 0) : 0), 0);
  }

  // Monthly Cloudflare usage by plan dimension, from each node's live rate.
  function dimUsage() {
    const params = {};
    state.nodes.forEach(n => { params[n.id] = eff(n).p; });
    return QE.usage(state.nodes, state.res, params, PRICING.hoursPerMonth);
  }

  function modelBucket() {
    return PRICING.modelSpend(state.nodes
      .filter(n => n.type === 'external_model')
      .map(n => ({ p: n.p, lambda: (state.res[n.id] || {}).lambda || 0 })));
  }

  function planLinesHtml(res, plan) {
    if (plan === 'custom') return '<div class="plan-line">base fee + usage &middot; no included allowances</div>';
    if (!res.lines.length) return '<div class="plan-line">no billable usage yet</div>';
    if (plan === 'free') {
      if (!res.exceeded.length) return '<div class="plan-line">within free limits</div>';
      return res.exceeded.map(l => {
        const lim = l.period === 'per request' ? l.limit + ' ms/req'
          : l.period === 'per day' ? human(l.daily) + '/day' : human(l.limit) + '/month';
        const used = l.period === 'per request' ? (Math.round(l.used * 10) / 10) + ' ms/req' : human(l.used) + '/month';
        return '<div class="plan-line over"><span>Free limit: ' + l.label + ' (' + lim + ')</span><b>' + used + '</b></div>';
      }).join('');
    }
    return res.lines.map(l =>
      '<div class="plan-line' + (l.cost > 0 ? ' over' : '') + '"><span>' + l.label + ' ' +
      human(l.used) + ' / ' + (l.included > 0 ? human(l.included) + ' per month' : 'no monthly allowance') +
      '</span><b>' + (l.cost > 0 ? '+' + money(l.cost) : '$0') + '</b></div>'
    ).join('');
  }

  // An estimate, not a measured user count: convert the first monthly limit
  // the current traffic would hit into requests, then apply the assumption.
  // No traffic or no monthly limit means no number at all.
  function capacityHtml(res, usage) {
    if (state.plan === 'custom' || !(usage.workersRequests > 0)) return '';
    const first = res.lines.filter(l => l.period !== 'per request' && l.used > 0)
      .reduce((a, l) => {
        const limit = l.limit != null ? l.limit : l.included;
        const ratio = limit > 0 ? l.used / limit : 0;
        return !a || ratio > a.ratio ? { label: l.label, limit, used: l.used, ratio } : a;
      }, null);
    if (!first || !(first.limit > 0)) return '';
    const perReq = first.used / usage.workersRequests;
    if (!(perReq > 0)) return '';
    const n = Math.floor(first.limit / perReq / REQ_PER_USER_PER_MONTH);
    if (!(n > 0)) return '';
    const plan = state.plan === 'paid' ? 'Paid $5' : 'Free';
    const tip = 'Estimate based on ' + REQ_PER_USER_PER_MONTH +
      ' requests per user per month. First limit: ' + first.label +
      ' (' + human(first.limit) + '/month).';
    return '~' + n.toLocaleString() + ' users on ' + plan +
      ' before the first limit <span class="info" title="' + esc(tip) + '">&#9432;</span>';
  }

  function renderCost() {
    const rate = state.rate;
    const hours = state.time / 3600;
    $('#k-rate').textContent = money(rate * 3600) + '/h';
    $('#k-spent').textContent = '$' + state.spent.toFixed(2);
    $('#k-time').textContent = hours < 1 ? Math.round(state.time) + 's' : hours.toFixed(2) + 'h';
    $('#k-lat').textContent = state.pathLat ? fmt(state.pathLat * 1000) : '\u2014';
    $('#k-cpu').textContent = Math.round(state.cpuRate || 0) + ' ms/s';
    const anyErr = state.nodes.some(n => (state.res[n.id] || {}).err > 0);
    const status = anyErr ? 'ERR' : state.pathLat >= 30 ? 'saturated' : state.pathLat > 3 ? 'slow' : 'ok';
    $('#k-path').textContent = status;
    $('#k-path').className = 'v ' + (anyErr || state.pathLat >= 30 ? 'bad' : state.pathLat > 3 ? 'warn' : 'good');

    const usage = dimUsage();
    const res = PRICING.monthlyCost(state.plan, Object.assign({}, usage, {
      baseFee: state.baseFee,
      rateMonthly: PRICING.monthlyUsage(rate)
    }));
    $('#k-total').textContent = money(res.total) + '/mo';
    $('#k-proj').textContent = money(res.total) + '/mo';

    // One headline, one chip: every figure comes from the monthlyCost result
    // above, never from a second pricing path.
    const overMoney = res.overage > 0;
    const overFree = state.plan === 'free' && res.exceeded.length > 0;
    const overBudget = state.plan === 'custom' && res.total > state.budget;
    const over = overMoney || overFree || overBudget;
    const chip = $('#over-chip');
    chip.textContent = overMoney ? '+ ' + money(res.overage) + ' overage'
      : overFree ? 'Outside Free limits'
      : overBudget ? '+ ' + money(res.total - state.budget) + ' over budget'
      : 'Within plan';
    chip.className = 'chip' + (over ? ' over' : '');

    // Included bar shows what the plan covers; the red Extra bar exists only
    // when there is an overage, and always carries its own label.
    const peak = res.lines.reduce((a, l) => l.ratio > (a ? a.ratio : -1) ? l : a, null);
    let used, limit, pct = 0, extra = null;
    if (state.plan === 'paid') {
      used = Math.min(res.total, res.base);
      limit = res.base;
      pct = limit > 0 ? used / limit * 100 : 0;
      if (overMoney) extra = { label: money(res.overage), pct: limit > 0 ? res.overage / limit * 100 : 100 };
    } else if (state.plan === 'custom') {
      used = Math.min(res.total, state.budget);
      limit = state.budget;
      pct = limit > 0 ? used / limit * 100 : 0;
      if (overBudget) extra = { label: money(res.total - state.budget), pct: limit > 0 ? (res.total - state.budget) / limit * 100 : 100 };
    } else if (peak) {
      used = peak.used;
      limit = peak.limit;
      pct = peak.ratio * 100;
      if (overFree) extra = { label: '+' + pctText((peak.ratio - 1) * 100) + '% over limit', pct: 100 };
    }
    $('#incl-label-text').textContent = state.plan === 'paid' ? 'Plan base / month'
      : state.plan === 'custom' ? 'Budget / month'
      : peak && peak.period === 'per day' ? 'Highest daily limit'
      : peak && peak.period === 'per request' ? 'Per-request limit'
      : 'Highest monthly limit';
    $('#incl-label').textContent = used == null ? '\u2014'
      : state.plan === 'free' && peak.period === 'per day' ? human(used) + ' / month vs ' + human(limit) + ' / day'
      : state.plan === 'free' && peak.period === 'per request' ? (Math.round(used * 10) / 10) + ' / ' + limit + ' ms/req'
      : money(used) + ' / ' + money(limit);
    const bar = $('#budget-bar');
    bar.style.width = Math.min(100, Math.max(0, pct)) + '%';
    bar.className = pct > 100 ? 'bad' : pct > 70 ? 'warn' : '';
    $('#extra-row').hidden = !extra;
    if (extra) {
      $('#extra-label').textContent = extra.label;
      $('#extra-bar').style.width = Math.min(100, extra.pct) + '%';
    }

    const capacity = capacityHtml(res, usage);
    $('#capacity').innerHTML = capacity;
    $('#capacity').hidden = !capacity;
    $('#plan-lines').innerHTML = planLinesHtml(res, state.plan);
    $('#cost-provenance').innerHTML = res.unverified.length
      ? '<b>Some prices are unverified</b><span>Unverified dimensions are excluded from the total. Workload rates and monthly totals are estimates.</span>'
      : '<b>Verified prices &amp; allowances</b><span>Workload rates and monthly totals are estimates.</span>';
    $('#custom-fields').hidden = state.plan !== 'custom';

    const ms = modelBucket();
    const mdl = $('#k-model');
    mdl.textContent = ms.set ? money(ms.total) + '/mo' : 'unset';
    mdl.className = ms.set ? 'v good' : '';
    $('#k-reqs').textContent = Math.round(state.requests).toLocaleString();
    $('#k-perreq').textContent = state.requests > 0 ? perReq(state.spent / state.requests) : '\u2014';
    $('#k-modelreq').textContent = !ms.set ? 'unset' : state.requests > 0 ? perReq(state.modelSpent / state.requests) : '\u2014';
  }

  function syncBillingControls() {
    $('#plan').value = state.plan;
    $('#budget').value = state.budget;
    $('#basefee').value = state.baseFee;
  }

  function setPlan(plan) {
    state.plan = plan;
    syncBillingControls();
    renderCost();
  }

  function setBillingInputs(patch) {
    Object.assign(state, patch);
    syncBillingControls();
    renderCost();
  }

  let drag = null, link = null, pan = null;

  function onNodeDown(ev) {
    if (ev.target.closest('.port')) return;
    ev.stopPropagation();
    const el = ev.target.closest('.node');
    const n = nodeById(el.dataset.id);
    el.focus({ preventScroll: true });
    select(n.id);
    drag = { id: n.id, sx: ev.clientX, sy: ev.clientY, ox: n.x, oy: n.y };
  }

  function onPortDown(ev) {
    ev.stopPropagation();
    ev.preventDefault();
    const el = ev.target.closest('.node');
    link = { from: el.dataset.id, x: 0, y: 0 };
    const a = nodeById(link.from);
    link.x0 = a.x + 74; link.y0 = a.y + 37;
    const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tmp.setAttribute('class', 'edge temp');
    tmp.id = 'temp-edge';
    $('#edge-layer').appendChild(tmp);
    link.el = tmp;
  }

  function onMove(ev) {
    if (drag) {
      const n = nodeById(drag.id);
      if (!n) return;
      n.x = drag.ox + (ev.clientX - drag.sx) / state.zoom;
      n.y = drag.oy + (ev.clientY - drag.sy) / state.zoom;
      renderNodes(); buildEdges();
      return;
    }
    if (link && link.el) {
      const rect = $('#canvas').getBoundingClientRect();
      const x2 = (ev.clientX - rect.left - state.px) / state.zoom;
      const y2 = (ev.clientY - rect.top - state.py) / state.zoom;
      const d = 'M' + link.x0 + ',' + link.y0 + ' C' + (link.x0 + 46) + ',' + link.y0 + ' ' + (x2 - 46) + ',' + y2 + ' ' + x2 + ',' + y2;
      link.el.setAttribute('d', d);
      return;
    }
    if (pan) {
      state.px = pan.px + (ev.clientX - pan.sx);
      state.py = pan.py + (ev.clientY - pan.sy);
      $('#world').style.transform = 'translate(' + state.px + 'px,' + state.py + 'px) scale(' + state.zoom + ')';
    }
  }

  function onUp(ev) {
    let changed = false;
    if (drag) {
      const n = nodeById(drag.id);
      changed = window.SCENARIO.moved(n, { x: drag.ox, y: drag.oy });
    }
    if (link) {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = el && el.closest('.node');
      if (target && target.dataset.id !== link.from) changed = !!addEdge(link.from, target.dataset.id) || changed;
      if (link.el) link.el.remove();
      link = null;
      compute(); render();
    }
    drag = null;
    pan = null;
    if (changed) pushScenario();
  }

  function select(id, revealInspector) {
    state.sel = id;
    renderNodes();
    renderInspector();
    setTab('components');
    if (revealInspector && mobile.matches) openMobileSheet('right', true);
  }

  function deleteSelected() {
    if (!state.sel) return;
    const index = state.nodes.findIndex(n => n.id === state.sel);
    const next = state.nodes[index + 1] || state.nodes[index - 1];
    state.nodes = state.nodes.filter(n => n.id !== state.sel);
    state.edges = state.edges.filter(e => e.from !== state.sel && e.to !== state.sel);
    state.sel = null;
    compute(); render();
    pushScenario();
    requestAnimationFrame(() => {
      if (mobile.matches && openSheet === 'right') {
        $('#close-inspector').focus({ preventScroll: true });
        return;
      }
      const el = next && Array.from($('#node-layer').children).find(node => node.dataset.id === next.id);
      (el || $('#canvas')).focus({ preventScroll: true });
    });
  }

  function fit() {
    if (!state.nodes.length) return;
    const minX = Math.min(...state.nodes.map(n => n.x)) - 20;
    const maxX = Math.max(...state.nodes.map(n => n.x + 74)) + 20;
    const minY = Math.min(...state.nodes.map(n => n.y)) - 20;
    const maxY = Math.max(...state.nodes.map(n => n.y + 120)) + 20;
    const w = $('#canvas').clientWidth, h = $('#canvas').clientHeight;
    const z = Math.max(0.35, Math.min(1, Math.min(w / (maxX - minX), h / (maxY - minY))));
    state.zoom = z;
    state.px = (w - (maxX - minX) * z) / 2 - minX * z;
    state.py = (h - (maxY - minY) * z) / 2 - minY * z;
    render();
  }

  function loadTemplate() {
    state.nodes = []; state.edges = []; seq = 1;
    state.name = 'Beauty store on Cloudflare';
    state.time = 0; state.spent = 0; state.requests = 0; state.modelSpent = 0; state.chaos = {};
    state.backlog = {}; state.drops = {};
    const t = addNode('traffic', 20, 220); t.p.rate = 12; t.alias = 'Storefront traffic';
    const waf = addNode('waf', 160, 220);
    const cache = addNode('cache', 300, 220);
    const workers = addNode('workers', 440, 220);
    const agent = addNode('durable_objects', 590, 220);
    const gw = addNode('ai_gateway', 750, 105);
    const model = addNode('workers_ai', 890, 105);
    const vec = addNode('vectorize', 750, 220);
    const d1 = addNode('d1', 750, 335);
    const q = addNode('queues', 440, 430);
    const ext = addNode('external', 600, 430);
    const sync = addNode('traffic', 20, 430); sync.p.rate = 1; sync.alias = 'Catalog sync';
    ext.p.latency = 500;
    addEdge(t.id, waf.id);
    addEdge(waf.id, cache.id);
    addEdge(cache.id, workers.id);
    addEdge(workers.id, agent.id);
    addEdge(agent.id, gw.id);
    addEdge(gw.id, model.id);
    addEdge(agent.id, vec.id);
    addEdge(agent.id, d1.id);
    addEdge(sync.id, q.id);
    addEdge(q.id, ext.id);
    state.sel = model.id;
    compute();
    render();
    fit();
  }

  function chaos(key) {
    const map = {
      m429: ['model429', 10], doEvict: ['doEvict', 8], d1Write: ['d1Write', 10],
      cacheStorm: ['cacheStorm', 12], store402: ['store402', 12], webhook: ['webhook', 10]
    };
    const [k, dur] = map[key];
    state.chaos[k] = state.time + dur;
    toast(label(key) + ' for ' + dur + ' seconds');
    compute(); render();
  }
  function label(k) {
    return { m429: 'Model 429s', doEvict: 'DO eviction', d1Write: 'D1 write storm', cacheStorm: 'Cache miss storm', store402: 'Store 402', webhook: 'Webhook storm' }[k];
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // Advance every Queue's backlog with simulated time. Reads the previous
  // compute() result for lambda, so the flow and the queue stay in agreement.
  function stepQueues(dtSim) {
    state.nodes.forEach(n => {
      if (n.type !== 'queues' || !(dtSim > 0)) return;
      const prev = state.res[n.id] || {};
      const qp = eff(n).p;
      const cap = QE.capacity(qp);
      const b = QE.step(state.backlog[n.id] || 0, prev.lambda || 0, cap, dtSim, qp.retention);
      state.backlog[n.id] = b.backlog;
      state.drops[n.id] = b.drops;
    });
  }

  function advanceSimulation(seconds) {
    if (!(seconds > 0)) return;
    QE.advanceClock(state, seconds, dt => {
      stepQueues(dt);
      const ms = modelBucket();
      return {
        rate: state.rate,
        requests: sourceRate(),
        modelRate: ms.set ? ms.total / (3600 * PRICING.hoursPerMonth) : 0
      };
    }, compute);
  }

  let lastReal = 0, acc = 0;
  function loop(ts) {
    if (!lastReal) lastReal = ts;
    const dtReal = Math.min(0.5, (ts - lastReal) / 1000);
    lastReal = ts;
    if (state.running) {
      advanceSimulation(dtReal * state.speed);
      acc += dtReal;
      if (acc >= 0.22) {
        acc = 0;
        renderCost(); renderNodes(); renderAlerts(); renderInspectorStats();
      }
    }
    animateEdges(ts);
    requestAnimationFrame(loop);
  }

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);

  $('#search').addEventListener('input', renderPalette);
  function syncRunControl() {
    $('#start').textContent = state.running ? 'Pause simulation' : 'Start simulation';
    $('#start').classList.toggle('on', state.running);
  }

  function setRunning(running) {
    state.running = !!running;
    syncRunControl();
    compute(); render();
  }

  function clearRuntime() {
    state.time = 0; state.spent = 0; state.requests = 0; state.modelSpent = 0; state.chaos = {};
    state.backlog = {}; state.drops = {}; lastReal = 0; acc = 0;
  }

  function resetSim() {
    clearRuntime();
    compute(); render(); toast('Simulation reset');
  }

  function resetApiRuntime() {
    state.running = false;
    clearRuntime();
    state.runId = nextRunId();
    syncRunControl();
    compute(); render();
  }

  function runSimulation(seconds) {
    setRunning(false);
    advanceSimulation(seconds);
    renderCost(); renderNodes(); renderAlerts(); renderInspectorStats();
  }

  $('#start').addEventListener('click', () => setRunning(!state.running));
  $('#reset').addEventListener('click', resetSim);
  function speedEq(v) {
    if (v < 60) return '1s = ' + v + 's';
    if (v < 3600) return '1s = ' + (Math.round(v / 6) / 10) + 'm';
    return '1s = ' + (Math.round(v / 360) / 10) + 'h';
  }
  function setSpeed(value) {
    const v = parseInt(value, 10);
    if (!isNaN(v)) state.speed = Math.max(1, Math.min(7200, v));
    $('#speed').value = state.speed;
    $('#speed-eq').innerHTML = '\u00d7 \u00b7 ' + speedEq(state.speed);
  }
  $('#speed').addEventListener('input', e => setSpeed(e.target.value));
  $('#speed-eq').innerHTML = '\u00d7 \u00b7 ' + speedEq(state.speed);
  $$('.chaos-btn').forEach(b => b.addEventListener('click', () => chaos(b.dataset.c)));
  $('#zoomin').addEventListener('click', () => { state.zoom = Math.min(1.8, state.zoom * 1.15); render(); });
  $('#zoomout').addEventListener('click', () => { state.zoom = Math.max(0.35, state.zoom / 1.15); render(); });
  $('#fit').addEventListener('click', fit);
  $('#budget').addEventListener('change', e => setBillingInputs({ budget: Math.max(1, parseFloat(e.target.value) || 1) }));
  $('#plan').addEventListener('change', e => setPlan(e.target.value));
  $('#basefee').addEventListener('change', e => setBillingInputs({ baseFee: Math.max(0, parseFloat(e.target.value) || 0) }));
  $('#k-asof').textContent = 'Prices verified as of ' + PRICING.asOf;
  $('#k-src').innerHTML = Object.keys(PRICING.sources).map(k =>
    '<a class="src" target="_blank" rel="noopener" href="' + PRICING.sources[k] + '">' +
    k.charAt(0).toUpperCase() + k.slice(1) + '</a>'
  ).join(' &middot; ');

  $('#canvas').addEventListener('pointerdown', ev => {
    if (ev.target.closest('.node')) return;
    $('#canvas').focus({ preventScroll: true });
    pan = { sx: ev.clientX, sy: ev.clientY, px: state.px, py: state.py };
    state.sel = null; renderNodes(); renderInspector();
  });
  $('#canvas').addEventListener('wheel', ev => {
    ev.preventDefault();
    state.zoom = Math.max(0.35, Math.min(1.8, state.zoom * (ev.deltaY < 0 ? 1.08 : 0.93)));
    render();
  }, { passive: false });

  let refocusing = false;
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && openSheet) {
      ev.preventDefault();
      closeMobileSheet();
      return;
    }
    if (ev.key === 'Tab' && openSheet) {
      const target = UX.trapFocus(document.activeElement, ev.shiftKey, sheetFocusables());
      if (target) {
        ev.preventDefault();
        refocusing = true;
        target.focus({ preventScroll: true });
        refocusing = false;
      }
    }
    if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.activeElement.isContentEditable) return;
    if (!state.sel) return;
    ev.preventDefault();
    deleteSelected();
  });
  document.addEventListener('focusin', ev => {
    if (!openSheet || refocusing) return;
    const focusable = sheetFocusables();
    if (focusable.indexOf(ev.target) >= 0) return;
    const target = UX.trapFocus(ev.target, false, focusable);
    if (target) {
      refocusing = true;
      target.focus({ preventScroll: true });
      refocusing = false;
    }
  });

  let rz = null;
  const refit = () => { clearTimeout(rz); rz = setTimeout(() => fit(), 140); };
  window.addEventListener('resize', refit);
  if (window.ResizeObserver) new ResizeObserver(refit).observe($('#canvas'));

  const app = document.querySelector('.app');
  const mobile = window.matchMedia('(max-width: 700px)');
  let openSheet = null;

  function setPanelClosed(panel, closed) {
    panel.inert = closed;
    panel.setAttribute('aria-hidden', String(closed));
  }

  function syncPanels() {
    const isMobile = mobile.matches;
    app.classList.toggle('mobile', isMobile);
    if (!isMobile) {
      app.classList.remove('palette-open', 'right-open');
      openSheet = null;
    }
    const paletteClosed = isMobile ? !app.classList.contains('palette-open') : app.classList.contains('no-pal');
    const inspectorClosed = isMobile ? !app.classList.contains('right-open') : app.classList.contains('no-insp');
    const active = document.activeElement;
    const activePanel = active && (active.closest('.palette') ? 'palette' : active.closest('.right') ? 'right' : null);
    if ((activePanel === 'palette' && paletteClosed) || (activePanel === 'right' && inspectorClosed)) active.blur();
    setPanelClosed($('#palette'), paletteClosed);
    setPanelClosed($('#right-panel'), inspectorClosed);
    $('#tog-pal').setAttribute('aria-expanded', String(!paletteClosed));
    $('#tog-insp').setAttribute('aria-expanded', String(!inspectorClosed));
    $('#tog-pal').classList.toggle('on', !paletteClosed);
    $('#tog-insp').classList.toggle('on', !inspectorClosed);
    $('#sheet-scrim').hidden = !(isMobile && openSheet);
    $('#close-palette').hidden = !isMobile;
    $('#close-inspector').hidden = !isMobile;
  }

  function sheetFocusables() {
    const panel = openSheet === 'palette' ? $('#palette') : $('#right-panel');
    const focusable = $$('button:not([hidden]),input:not([hidden]),select:not([hidden]),a[href],summary', panel)
      .filter(UX.sheetFocusable);
    if (!$('#error-retry').hidden) focusable.unshift($('#error-retry'));
    return focusable;
  }

  function openMobileSheet(name, focusPanel) {
    if (!mobile.matches) return;
    app.classList.toggle('palette-open', name === 'palette');
    app.classList.toggle('right-open', name === 'right');
    openSheet = name;
    syncPanels();
    if (focusPanel) requestAnimationFrame(() => {
      if (openSheet !== name) return;
      (name === 'palette' ? $('#search') : $('#close-inspector')).focus({ preventScroll: true });
    });
  }

  function closeMobileSheet() {
    const previous = openSheet;
    app.classList.remove('palette-open', 'right-open');
    openSheet = null;
    syncPanels();
    if (previous) (previous === 'palette' ? $('#tog-pal') : $('#tog-insp')).focus();
  }

  const togglePanel = cls => {
    if (mobile.matches) {
      const name = cls === 'no-pal' ? 'palette' : 'right';
      if (openSheet === name) closeMobileSheet();
      else openMobileSheet(name, true);
      return;
    }
    app.classList.toggle(cls);
    syncPanels();
    refit();
  };
  $('#tog-pal').addEventListener('click', () => togglePanel('no-pal'));
  $('#tog-insp').addEventListener('click', () => togglePanel('no-insp'));
  $('#close-palette').addEventListener('click', closeMobileSheet);
  $('#close-inspector').addEventListener('click', closeMobileSheet);
  $('#sheet-scrim').addEventListener('click', closeMobileSheet);
  if (mobile.addEventListener) mobile.addEventListener('change', syncPanels);
  else mobile.addListener(syncPanels);
  syncPanels();

  const tabCost = $('#tab-cost'), tabComponents = $('#tab-components');
  const tabNames = ['cost', 'components'];
  function setTab(name, moveFocus) {
    const cost = name === 'cost';
    $('#cost').hidden = !cost;
    $('#inspect').hidden = cost;
    tabCost.classList.toggle('on', cost);
    tabComponents.classList.toggle('on', !cost);
    tabCost.setAttribute('aria-selected', String(cost));
    tabComponents.setAttribute('aria-selected', String(!cost));
    tabCost.tabIndex = cost ? 0 : -1;
    tabComponents.tabIndex = cost ? -1 : 0;
    if (moveFocus) (cost ? tabCost : tabComponents).focus();
  }
  tabCost.addEventListener('click', () => setTab('cost'));
  tabComponents.addEventListener('click', () => setTab('components'));
  $('.cost-tabs').addEventListener('keydown', ev => {
    const current = tabCost.getAttribute('aria-selected') === 'true' ? 'cost' : 'components';
    const next = UX.nextTab(current, ev.key, tabNames);
    if (next !== current) {
      ev.preventDefault();
      setTab(next, true);
    }
  });
  setTab('cost');

  // Scenario channel: scenario.json is the source of truth for humans and agents.
  function currentScenario() {
    const nodes = state.nodes.map(n => {
      const o = { id: n.id, type: n.type, x: Math.round(n.x), y: Math.round(n.y) };
      if (n.alias) o.alias = n.alias;
      o.p = Object.assign({}, n.p);
      Object.keys(n).forEach(k => { if (NODE_KEYS.indexOf(k) < 0) o[k] = n[k]; });
      return o;
    }).concat(state.opaque);
    const edges = state.edges.map(e => {
      const o = { from: e.from, to: e.to };
      if (typeof e.weight === 'number') o.weight = e.weight;
      Object.keys(e).forEach(k => { if (EDGE_KEYS.indexOf(k) < 0) o[k] = e[k]; });
      return o;
    });
    const scenario = { version: window.SCENARIO.VERSION, name: state.name, nodes: nodes, edges: edges };
    Object.keys(state.rootExtra).forEach(k => { scenario[k] = state.rootExtra[k]; });
    return scenario;
  }

  function simState() {
    // Units: time is simulated seconds, spent/rate are USD and USD/s,
    // per-node lat is seconds, cost is USD/s, lambda is req/s, util/err are 0..1.
    const nodes = Object.create(null);
    state.nodes.forEach(n => {
      const r = state.res[n.id] || {};
      nodes[n.id] = {
        type: n.type, lambda: r.lambda || 0, util: r.util || 0,
        err: r.err || 0, lat: r.lat || 0, cost: r.cost || 0,
        out: r.out || 0, capacity: r.capacity || 0,
        backlog: state.backlog[n.id] || 0, drops: state.drops[n.id] || 0,
        billedRequests: r.billedRequests || 0, doGbS: r.doGbS || 0,
        objects: r.objects || 0, perObjectRate: r.perObjectRate || 0,
        objectLimit: r.objectLimit || 0, overloaded: !!r.overloaded
      };
    });
    const usage = dimUsage();
    const monthly = PRICING.monthlyCost(state.plan, Object.assign({}, usage, {
      baseFee: state.baseFee, rateMonthly: PRICING.monthlyUsage(state.rate)
    }));
    return {
      time: state.time, spent: state.spent, rate: state.rate,
      pathLat: state.pathLat, running: state.running, speed: state.speed, plan: state.plan,
      baseFee: state.baseFee, budget: state.budget, requests: state.requests, requestCount: state.requests,
      modelSpent: state.modelSpent, cpuRate: state.cpuRate,
      scenarioRevision: state.scenarioRevision, scenarioHash: state.scenarioHash,
      runId: state.runId, dirty: state.dirty, saving: state.saving, saveError: state.saveError,
      chaos: Object.keys(state.chaos).filter(k => state.chaos[k] > state.time),
      usage, monthly, modelSpend: modelBucket(), nodes
    };
  }

  function installScenario(s, doFit, warning, options) {
    const settings = Object.assign({ resetRuntime: true, persisted: false, newRunId: true }, options || {});
    const known = s.nodes.filter(hasType);
    const backlog = {};
    const drops = {};
    if (!settings.resetRuntime) {
      known.filter(n => n.type === 'queues').forEach(n => {
        backlog[n.id] = state.backlog[n.id] || 0;
        drops[n.id] = state.drops[n.id] || 0;
      });
    }
    const clock = settings.resetRuntime ? { time: 0, chaos: {} } : state;
    const model = modelFor(known, s.edges, backlog, drops, clock);
    const rootExtra = {};
    Object.keys(s).forEach(k => { if (ROOT_KEYS.indexOf(k) < 0) rootExtra[k] = s[k]; });
    const previousState = Object.assign({}, state);
    const previousDrag = drag, previousLink = link, previousSeq = seq;
    try {
      const keep = state.sel;
      state.name = s.name;
      state.nodes = known;
      state.opaque = s.nodes.filter(n => !hasType(n));
      state.rootExtra = rootExtra;
      state.edges = s.edges;
      state.sel = keep && state.nodes.some(n => n.id === keep) ? keep : null;
      drag = null;
      link = null;
      seq = window.SCENARIO.nextNodeSeq(s.nodes);
      if (settings.resetRuntime) {
        clearRuntime();
        state.running = false;
      }
      state.backlog = backlog;
      state.drops = drops;
      if (settings.newRunId !== false) state.runId = nextRunId();
      if (settings.persisted) {
        state.scenarioRevision = storedRevision;
        state.scenarioHash = storedHash;
        state.dirty = false;
        state.saveError = null;
      } else {
        markDirty();
      }
      applyModel(model);
      syncRunControl();
      render();
      if (doFit) fit();
      if (warning) toast(warning);
      return true;
    } catch (err) {
      Object.assign(state, previousState);
      drag = previousDrag;
      link = previousLink;
      seq = previousSeq;
      syncRunControl();
      render();
      throw err;
    }
  }

  function applyScenario(raw, doFit, storage) {
    const res = window.SCENARIO.validate(raw, window.CATALOG);
    if (!res.scenario || res.dropped > 0) {
      toast(res.error || 'Invalid scenario');
      return false;
    }
    const s = res.scenario;
    const known = s.nodes.filter(hasType);
    if (!known.length && s.nodes.length) {
      toast(res.error || 'Scenario has no renderable nodes');
      return false;
    }
    if (storage) setStoredIdentity(storage);
    return installScenario(s, doFit, res.error, {
      resetRuntime: !storage,
      persisted: !!storage,
      newRunId: !!storage
    });
  }

  function setNodeParams(nodeId, patch) {
    const node = nodeById(nodeId);
    if (!node) throw new Error('Unknown node');
    const previousParams = node.p;
    const nextParams = Object.assign({}, previousParams, patch);
    const nodes = state.nodes.map(n => n.id === nodeId ? Object.assign({}, n, { p: nextParams }) : n);
    const model = modelFor(nodes, state.edges, state.backlog, state.drops);
    const previousModel = { res: state.res, cpuRate: state.cpuRate, rate: state.rate, pathLat: state.pathLat };
    const previousIdentity = {
      scenarioRevision: state.scenarioRevision, scenarioHash: state.scenarioHash,
      dirty: state.dirty, saveError: state.saveError
    };
    try {
      node.p = nextParams;
      markDirty();
      applyModel(model);
      render();
    } catch (err) {
      node.p = previousParams;
      Object.assign(state, previousIdentity);
      Object.assign(state, previousModel);
      render();
      throw err;
    }
    return { nodeId, params: Object.assign({}, nextParams) };
  }

  const http = /^https?:$/.test(location.protocol);
  const clientId = Math.random().toString(36).slice(2);
  let saveTimer = null;
  let channel = null;
  let subscribe = null;
  let channelMode = http ? 'checking' : 'local';
  let pendingSave = false;
  let storedRevision = null;
  let storedHash = null;
  let storedEtag = null;
  let saveQueue = Promise.resolve();
  let channelReady;
  const newChannelReady = () => {
    let resolve;
    channelReady = new Promise(r => { resolve = r; });
    channelReady.resolve = resolve;
    return channelReady;
  };
  newChannelReady();
  if (!http) channelReady.resolve(false);
  const bannerErrors = {};
  let saveState = UX.saveStatus({ type: 'local' });

  function renderBannerError() {
    const error = UX.bannerError(bannerErrors);
    $('#channel-error-text').textContent = error ? error.message : '';
    $('#error-retry').hidden = !(error && error.retry);
    $('#channel-error').hidden = !error;
  }

  function showError(message, retry, scope) {
    bannerErrors[scope || 'save'] = { message, retry: retry || null };
    renderBannerError();
  }

  function clearError(scope) {
    delete bannerErrors[scope];
    renderBannerError();
  }

  function renderSaveState() {
    const el = $('#save-status');
    el.textContent = saveState.message;
    el.dataset.phase = saveState.phase;
  }

  function setSave(event, retry, scope) {
    saveState = UX.saveStatus(event);
    if (saveState.phase === 'error') {
      showError(saveState.message, saveState.retryable ? retry : null, scope || 'save');
    } else if (bannerErrors.save) {
      clearError('save');
    }
    renderSaveState();
  }

  function setStoredIdentity(storage) {
    const revision = storage && Number(storage.revision);
    storedRevision = Number.isInteger(revision) ? revision : null;
    storedHash = storage && typeof storage.hash === 'string' ? storage.hash : null;
    storedEtag = storage && storage.etag || (storedHash ? '"' + storedHash + '"' : null);
  }

  function markDirty() {
    state.dirty = true;
    state.scenarioRevision = null;
    state.scenarioHash = null;
    state.saveError = null;
  }

  function saveFailure(error) {
    state.dirty = true;
    state.saveError = error;
    return { error };
  }

  async function postScenario(scenario, body) {
    state.saving = true;
    const ready = channelReady;
    try {
      const available = http ? await ready : false;
      if (!available) {
        return saveFailure({ code: 'CHANNEL_UNAVAILABLE', message: 'Scenario channel is unavailable' });
      }
      const headers = { 'content-type': 'application/json', 'x-client-id': clientId };
      if (storedEtag) headers['if-match'] = storedEtag;
      let response;
      try {
        response = await fetch('/scenario', { method: 'POST', headers, body });
      } catch (err) {
        return saveFailure({ code: 'CHANNEL_UNAVAILABLE', message: String((err && err.message) || err).split('\n')[0] });
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        const code = response.status === 409 || payload.code === 'STORAGE_CONFLICT'
          ? 'STORAGE_CONFLICT'
          : 'SAVE_FAILED';
        return saveFailure({
          code,
          message: payload.error || 'Scenario save failed',
          details: { status: response.status }
        });
      }
      if (!Number.isInteger(payload.revision) || typeof payload.hash !== 'string' || !payload.scenario) {
        return saveFailure({ code: 'SAVE_FAILED', message: 'Scenario channel returned an invalid save result' });
      }
      setStoredIdentity({ revision: payload.revision, hash: payload.hash, etag: response.headers.get('etag') });
      if (JSON.stringify(currentScenario()) === body) {
        installScenario(payload.scenario, false, null, { resetRuntime: false, persisted: true, newRunId: false });
        state.scenarioRevision = storedRevision;
        state.scenarioHash = storedHash;
        state.dirty = false;
        state.saveError = null;
      }
      return {
        data: {
          revision: payload.revision,
          eventId: payload.eventId,
          hash: payload.hash,
          scenario: payload.scenario
        }
      };
    } catch (err) {
      return saveFailure({ code: 'SAVE_FAILED', message: String((err && err.message) || err).split('\n')[0] });
    } finally {
      state.saving = false;
    }
  }

  function saveScenario(scenario) {
    const payload = cloneJson(scenario || currentScenario());
    const body = JSON.stringify(payload);
    const task = saveQueue.then(() => postScenario(payload, body));
    saveQueue = task.catch(() => {});
    return task;
  }

  function pushScenario() {
    markDirty();
    if (!http || channelMode === 'local') {
      pendingSave = false;
      if (channelMode === 'local') setSave({ type: 'local' });
      return;
    }
    pendingSave = true;
    clearTimeout(saveTimer);
    if (channelMode !== 'live') return;
    setSave({ type: 'saving' });
    saveTimer = setTimeout(() => {
      saveScenario().then(result => {
        if (result.error) {
          const status = result.error.details && result.error.details.status;
          const retry = () => { clearTimeout(saveTimer); saveScenario().then(r => applySaveResult(r)); };
          if (status === 400) setSave({ type: 'rejected', message: result.error.message });
          else if (result.error.code === 'CHANNEL_UNAVAILABLE') setSave({ type: 'network' }, retry);
          else setSave({ type: 'http', status: status || 500 }, retry);
        } else {
          pendingSave = false;
          setSave({ type: 'saved' });
          if (!channel) subscribe();
        }
      });
    }, 400);
  }

  function applySaveResult(result) {
    if (result.error) {
      const status = result.error.details && result.error.details.status;
      const retry = () => { clearTimeout(saveTimer); saveScenario().then(r => applySaveResult(r)); };
      if (status === 400) setSave({ type: 'rejected', message: result.error.message });
      else if (result.error.code === 'CHANNEL_UNAVAILABLE') setSave({ type: 'network' }, retry);
      else setSave({ type: 'http', status: status || 500 }, retry);
      return;
    }
    pendingSave = false;
    setSave({ type: 'saved' });
    if (!channel) subscribe();
  }
  function copyText(text, successMessage) {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      if (ok) {
        clearError('copy');
        toast(successMessage);
      } else {
        showError('Copy failed. Select and copy the text manually.', null, 'copy');
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        clearError('copy');
        toast(successMessage);
      }, fallback);
    } else {
      fallback();
    }
  }

  function copyJson() {
    copyText(JSON.stringify(currentScenario(), null, 2), 'Scenario JSON copied');
  }

  function copyLink() {
    const encoded = window.SCENARIO.encode(currentScenario());
    if (!encoded) {
      showError('Link is too large (8,000-character limit). Use Copy JSON instead.', null, 'copy');
      toast('Link is too large. Use Copy JSON instead.');
      return;
    }
    copyText(location.href.split('#')[0] + '#s=' + encoded, 'Scenario link copied');
  }

  $('#copy-json').addEventListener('click', copyJson);
  $('#copy-link').addEventListener('click', copyLink);
  $('#error-retry').addEventListener('click', () => {
    const error = UX.bannerError(bannerErrors);
    if (error && error.retry) error.retry();
  });
  renderSaveState();

  window.__SIM__ = {
    load: raw => applyScenario(raw, true),
    export: currentScenario,
    getState: simState
  };

  window.SIM_API = window.SIM_API_FACTORY.createAgentApi({
    scenario: window.SCENARIO,
    catalog: window.CATALOG,
    pricing: PRICING,
    getScenario: currentScenario,
    getSimulation: simState,
    getIdentity: () => ({
      scenarioRevision: state.scenarioRevision,
      scenarioHash: state.scenarioHash,
      runId: state.runId,
      dirty: state.dirty,
      saving: state.saving,
      saveError: state.saveError
    }),
    getModel: () => ({ requestsPerUserPerMonth: REQ_PER_USER_PER_MONTH, engine: Object.assign({}, QE.MODEL) }),
    loadScenario: (s, options) => installScenario(s, true, null, options),
    setParams: setNodeParams,
    setPlan,
    setBillingInputs,
    start: speed => {
      if (speed !== undefined) setSpeed(speed);
      setRunning(true);
    },
    pause: () => setRunning(false),
    reset: resetApiRuntime,
    run: runSimulation,
    setSpeed,
    saveScenario: scenario => {
      clearTimeout(saveTimer);
      return saveScenario(scenario);
    },
    getChannelStatus: () => ({
      available: !!channel,
      saving: state.saving,
      revision: storedRevision,
      hash: storedHash
    })
  });

  renderPalette();
  loadTemplate();
  syncBillingControls();

  let booted = false;
  const hashMatch = /^#s=(.+)$/.exec(location.hash);
  let hashRaw = null;
  if (hashMatch) {
    hashRaw = window.SCENARIO.decode(hashMatch[1]);
    if (!hashRaw) toast('Invalid #s= scenario link');
  }
  [hashRaw, window.__SCENARIO__].forEach(c => {
    if (c && !booted) booted = applyScenario(c, true);
  });

  if (http) {
    subscribe = () => {
      if (channel) return;
      const source = new EventSource('/events');
      channel = source;
      channelReady.resolve(true);
      source.onopen = () => {
        if (channel !== source) return;
        clearError('channel');
        if (!pendingSave) setSave({ type: 'saved' });
      };
      source.onmessage = ev => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (!msg || !msg.scenario || msg.clientId === clientId) return;
        const storage = { revision: msg.revision, hash: msg.hash, etag: msg.hash ? '"' + msg.hash + '"' : null };
        if (JSON.stringify(msg.scenario) === JSON.stringify(currentScenario())) {
          setStoredIdentity(storage);
          state.scenarioRevision = storedRevision;
          state.scenarioHash = storedHash;
          state.dirty = false;
          state.saveError = null;
          return;
        }
        const before = state.nodes.map(n => n.id).join('|');
        if (applyScenario(msg.scenario, false, storage)) {
          booted = true;
          if (state.nodes.map(n => n.id).join('|') !== before) fit();
          if (!pendingSave) setSave({ type: 'saved' });
          toast('Scenario updated from the server');
        }
      };
      source.onerror = () => {
        source.close();
        if (channel === source) channel = null;
        setSave({ type: 'disconnected' }, () => subscribe(), 'channel');
      };
    };
    const bootstrap = () => {
      const ready = newChannelReady();
      channelMode = 'checking';
      clearError('channel');
      setSave({ type: 'checking' });
      return fetch('/scenario').then(r => {
        const type = r.headers.get('content-type') || '';
        if (type.indexOf('json') < 0) {
          channelMode = 'local';
          pendingSave = false;
          ready.resolve(false);
          setSave({ type: 'local' });
          return null;
        }
        if (!r.ok) {
          channelMode = 'error';
          ready.resolve(false);
          setSave({ type: 'unavailable', status: r.status }, bootstrap, 'channel');
          return null;
        }
        const storage = {
          revision: r.headers.get('x-scenario-revision'),
          hash: r.headers.get('x-scenario-hash'),
          etag: r.headers.get('etag')
        };
        channelMode = 'live';
        subscribe();
        return r.json().then(s => {
          if (!s) return;
          if (UX.bootstrapApply(pendingSave, state.dirty, booted) === 'apply') {
            booted = applyScenario(s, true, storage);
          } else {
            setStoredIdentity(storage);
            booted = true;
          }
        });
      }).then(() => {
        if (channelMode === 'live' && pendingSave) pushScenario();
      }).catch(() => {
        channelMode = 'error';
        ready.resolve(false);
        setSave({ type: 'network' }, bootstrap, 'channel');
      });
    };
    bootstrap();
  }

  window.addEventListener('hashchange', () => {
    const m = /^#s=(.+)$/.exec(location.hash);
    if (!m) return;
    const s = window.SCENARIO.decode(m[1]);
    if (s) applyScenario(s, true);
    else toast('Invalid #s= scenario link');
  });

  requestAnimationFrame(loop);
})();
