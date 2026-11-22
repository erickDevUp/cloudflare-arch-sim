(function () {
  const TYPES = window.CATALOG.types;
  const GROUPS = window.CATALOG.groups;
  const NS = 'http://www.w3.org/2000/svg';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const state = {
    nodes: [], edges: [], sel: null, zoom: 1, px: 40, py: 40,
    running: false, speed: 60, budget: 5000, edgeEls: [], cpuRate: 0,
    t: 0, spent: 0, chaos: {}, errors: 0,
    res: {}, rate: 0, pathLat: 0
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

  function eff(n) {
    const p = Object.assign({}, n.p);
    const now = performance.now() / 1000;
    let slashed = false;
    if (n.type === 'workers_ai' && state.chaos.model429 > now) {
      p.latency *= 3; p.concurrency = Math.max(1, Math.round(p.concurrency * 0.4)); slashed = true;
    }
    if (n.type === 'durable_objects' && state.chaos.doEvict > now) {
      p.latency *= 8; slashed = true;
    }
    if (n.type === 'd1' && state.chaos.d1Write > now) {
      p.latency *= 20; slashed = true;
    }
    if (n.type === 'cache' && state.chaos.cacheStorm > now) {
      p.hit = 0; slashed = true;
    }
    if (n.type === 'external' && state.chaos.store402 > now) {
      p.latency *= 100; slashed = true;
    }
    if (n.type === 'queues' && state.chaos.webhook > now) {
      p.latency *= 2; slashed = true;
    }
    return { p, slashed };
  }

  function erlangC(a, c) {
    if (c <= 1) return Math.min(1, a);
    if (a <= 0) return 0;
    const rho = a / c;
    if (rho >= 1) return 1;
    let sum = 1, term = 1;
    const cap = Math.min(c, 400);
    for (let k = 1; k < cap; k++) { term *= a / k; sum += term; }
    const acfact = term * a / cap;
    const tail = acfact / (1 - rho);
    return tail / (sum + tail);
  }

  function compute() {
    const inc = {}, out = {};
    state.nodes.forEach(n => { inc[n.id] = []; out[n.id] = []; });
    state.edges.forEach(e => {
      if (out[e.from]) out[e.from].push(e.to);
      if (inc[e.to]) inc[e.to].push(e.from);
    });

    const indeg = {};
    state.nodes.forEach(n => { indeg[n.id] = inc[n.id].length; });
    const q = state.nodes.filter(n => indeg[n.id] === 0).map(n => n.id);
    const order = [];
    while (q.length) {
      const id = q.shift();
      order.push(id);
      out[id].forEach(to => { indeg[to]--; if (indeg[to] === 0) q.push(to); });
    }

    const lambda = {}, outLambda = {}, lat = {}, arrive = {};
    state.nodes.forEach(n => { lambda[n.id] = 0; outLambda[n.id] = 0; lat[n.id] = 0; arrive[n.id] = 0; });

    order.forEach(id => {
      const n = nodeById(id);
      if (!n) return;
      const { p } = eff(n);
      const t = typeOf(n);
      if (t.source) {
        lambda[id] = p.rate;
        lat[id] = 0;
        outLambda[id] = p.rate;
        state.res[id] = { lambda: p.rate, util: 0, err: 0, lat: 0, hit: 0, cpu: 0, cost: 0 };
      } else {
        let util = 0, waitS = 0;
        if (p.concurrency > 0 && p.latency > 0) {
          const mu = 1000 / p.latency;
          util = lambda[id] / (mu * p.concurrency);
          if (util >= 1) {
            waitS = 30;
          } else if (p.concurrency > 400) {
            waitS = 0;
          } else if (util > 0.005) {
            const C = erlangC(lambda[id] / mu, Math.max(1, Math.round(p.concurrency)));
            waitS = C / Math.max(0.0001, p.concurrency * mu - lambda[id]);
          }
        }
        const latS = p.latency / 1000 + waitS;
        lat[id] = latS;
        const hit = n.type === 'cache' ? Math.max(0, Math.min(100, p.hit)) / 100 : 0;
        outLambda[id] = lambda[id] * (1 - hit);
        const failing = n.type === 'external' && state.chaos.store402 > performance.now() / 1000;
        const err = failing ? 1 : util > 1 ? Math.min(0.85, (util - 1) * 0.55) : 0;
        state.res[id] = { lambda: lambda[id], util, err, lat: latS, hit, cpu: 0, cost: 0 };
      }
      out[id].forEach(to => {
        lambda[to] += outLambda[id];
        arrive[to] = Math.max(arrive[to], arrive[id] + lat[id]);
      });
    });

    state.cpuRate = 0;
    state.nodes.forEach(n => {
      const r = state.res[n.id] || (state.res[n.id] = { lambda: 0, util: 0, err: 0, lat: 0, cpu: 0, cost: 0 });
      const { p } = eff(n);
      const def = typeOf(n);
      let cost = r.lambda * p.units * p.price / 1e6;
      if (def.priceCpu && p.cpuMs) cost += r.lambda * p.cpuMs * def.priceCpu / 1e6;
      if (n.type === 'durable_objects' && p.priceGBs != null) {
        cost += r.lambda * r.lat * 0.128 * p.priceGBs / 1e6;
      }
      r.cost = cost;
      r.cpu = (p.cpuMs || 0) * r.lambda;
      state.cpuRate += r.cpu;
    });

    let rate = 0;
    Object.keys(state.res).forEach(k => { rate += state.res[k].cost || 0; });
    state.rate = rate;
    state.pathLat = state.nodes.reduce((m, n) => Math.max(m, (state.res[n.id] || {}).lat || 0), 0);
  }

  function renderPalette() {
    const q = ($('#search').value || '').toLowerCase();
    const wrap = $('#palette-list');
    wrap.innerHTML = '';
    GROUPS.forEach(g => {
      const items = Object.keys(TYPES).filter(k => TYPES[k].group === g.id && TYPES[k].name.toLowerCase().includes(q));
      if (!items.length) return;
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
        el.addEventListener('pointerdown', ev => ev.stopPropagation());
        el.addEventListener('pointerdown', ev => {
          ev.preventDefault();
          const rect = $('#canvas').getBoundingClientRect();
          const gx = (rect.width / 2 - state.px) / state.zoom;
          const gy = (rect.height / 2 - state.py) / state.zoom;
          const n = addNode(k, gx - 37, gy - 37);
          select(n.id);
          drag = { id: n.id, sx: ev.clientX, sy: ev.clientY, ox: n.x, oy: n.y };
          render();
        });
        grid.appendChild(el);
      });
      sec.appendChild(grid);
      wrap.appendChild(sec);
    });
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
    buildEdges();
    renderNodes();
    renderInspector();
    renderCost();
    renderAlerts();
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
      state.edgeEls.push({ path, dots, len, pts: samplePath(path, len), to: e.to });
    });
  }

  function animateEdges(ts) {
    const t = ts / 1000;
    (state.edgeEls || []).forEach(e => {
      const r = state.res[e.to] || {};
      const lam = r.lambda || 0;
      const hot = (r.util || 0) >= 0.9 || (r.err || 0) > 0;
      const cls = 'edge' + (hot ? ' hot' : '');
      if (e.path.getAttribute('class') !== cls) e.path.setAttribute('class', cls);
      if (!state.running || lam <= 0 || e.len <= 0) {
        e.dots.forEach(d => { if (d.el.style.opacity !== '0') d.el.style.opacity = 0; });
        return;
      }
      const rate = Math.min(50, lam);
      let speed = 90 + Math.min(180, lam * 2.2);
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
      el.style.left = n.x + 'px';
      el.style.top = n.y + 'px';
      const color = groupColor(n.type);
      el.innerHTML =
        '<div class="nbox ' + cls + '" style="--c:' + color + '">' +
          '<span class="nicon">' + svg(n.type) + '</span>' +
          (def.source ? '<span class="nrate">' + Math.round(r.lambda) + '/s</span>' : '') +
          '<span class="nbar"><i class="' + barCls + '" style="width:' + Math.min(100, pct) + '%"></i></span>' +
        '</div>' +
        '<div class="nlabel">' + (n.alias || def.name) + '</div>' +
        '<div class="nbadge ' + bcls + '">' + badge(n, r) + '</div>' +
        '<span class="port" data-port="1"></span>';
      layer.appendChild(el);
    });
    $$('.node').forEach(el => { el.addEventListener('pointerdown', onNodeDown); });
    $$('.port').forEach(p => { p.addEventListener('pointerdown', onPortDown); });
  }

  function badge(n, r) {
    if (typeOf(n).source) return Math.round(r.lambda || 0) + '/s in';
    if (!r || !r.lambda) return 'idle';
    const pct = Math.round((r.util || 0) * 100);
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
    if (over) out.push({ t: 'HOT PATH BOTTLENECK \u00b7 ' + nname(over.n), c: 'crit' });
    if (errs.length) out.push({ t: 'ERROR BUDGET BURN', c: 'warn' });
    if (drops) out.push({ t: 'DATA LOSS RISK \u00b7 sync drops', c: 'warn' });
    if (spof && out.length < 3) out.push({ t: 'SPOF \u00b7 ' + nname(spof.n), c: 'warn' });
    $('#alerts').innerHTML = out.slice(0, 3).map(a => '<span class="alert ' + a.c + '">' + a.t + '</span>').join('');
  }

  function renderInspector() {
    const box = $('#inspect');
    if (!state.sel) {
      box.innerHTML = '<div class="empty">Select a node to edit it.<br><br>Add from the palette. Drag the dot on a node to connect. Drag the canvas to pan.</div>';
      return;
    }
    const n = nodeById(state.sel);
    if (!n) return;
    const def = typeOf(n);
    const r = state.res[n.id] || {};
    const fields = def.fields || ['concurrency', 'latency', 'price'];
    const labels = {
      rate: ['Requests / s', 1, 100000, 1],
      concurrency: ['Concurrency', 1, 1000000, 1],
      latency: ['Service time (ms)', 0, 60000, 1],
      price: ['$ per million units', 0, 100, 0.001],
      units: ['Units per request', 0, 100000, 1],
      hit: ['Cache hit %', 0, 100, 1],
      priceGBs: ['$ per M GB-s', 0, 100, 0.01],
      cpuMs: ['CPU ms / request', 0, 30000, 0.5]
    };
    let html = '<div class="ins-head"><span class="dot" style="background:' + groupColor(n.type) + '"></span><b>' + (n.alias || def.name) + '</b></div>';
    html += '<div class="ins-sub">' + (def.verified ? '<span class="ok">verified in docs</span>' : '<span class="asm">assumption &mdash; edit it</span>') + '</div>';
    fields.forEach(f => {
      const L = labels[f] || [f, 0, 1e6, 1];
      html += '<label class="field"><span>' + L[0] + '</span><input type="number" data-f="' + f + '" min="' + L[1] + '" max="' + L[2] + '" step="' + L[3] + '" value="' + n.p[f] + '"></label>';
    });
    html += '<div class="ins-stats">' +
      '<div><span>in</span><b>' + (r.lambda ? r.lambda.toFixed(1) + '/s' : '\u2014') + '</b></div>' +
      '<div><span>util</span><b>' + (r.util ? Math.round(r.util * 100) + '%' : '\u2014') + '</b></div>' +
      '<div><span>errors</span><b>' + (r.err ? Math.round(r.err * 100) + '%' : '0%') + '</b></div>' +
      '<div><span>latency</span><b>' + (r.lat ? fmt(r.lat * 1000) : '\u2014') + '</b></div>' +
      '<div><span>cost/h</span><b>' + (r.cost ? '$' + (r.cost * 3600).toFixed(2) : '$0') + '</b></div>' +
      '</div>';
    if (def.note) html += '<p class="note">' + def.note + '</p>';
    if (def.verified) html += '<p class="note ok-note">' + def.verified + '</p>';
    if (def.doc) html += '<a class="src" target="_blank" rel="noopener" href="' + def.doc + '">source</a>';
    html += '<button class="del" id="delnode">Delete node</button>';
    box.innerHTML = html;
    $$('input[data-f]', box).forEach(inp => {
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        if (!isNaN(v)) { n.p[inp.dataset.f] = v; compute(); renderNodes(); renderCost(); }
      });
    });
    $('#delnode').addEventListener('click', () => {
      state.nodes = state.nodes.filter(x => x.id !== n.id);
      state.edges = state.edges.filter(e => e.from !== n.id && e.to !== n.id);
      state.sel = null;
      compute(); render();
    });
  }

  function fmt(v) { return v < 1000 ? Math.round(v) + 'ms' : (v / 1000).toFixed(1) + 's'; }

  function renderCost() {
    const rate = state.rate;
    const hours = state.t / 3600;
    $('#k-rate').textContent = '$' + (rate * 3600).toFixed(2) + '/h';
    $('#k-spent').textContent = '$' + state.spent.toFixed(2);
    $('#k-time').textContent = hours < 1 ? Math.round(state.t) + 's' : hours.toFixed(2) + 'h';
    $('#k-lat').textContent = state.pathLat ? fmt(state.pathLat * 1000) : '\u2014';
    $('#k-cpu').textContent = Math.round(state.cpuRate || 0) + ' ms/s';
    const anyErr = state.nodes.some(n => (state.res[n.id] || {}).err > 0);
    const status = anyErr ? 'ERR' : state.pathLat >= 30 ? 'saturated' : state.pathLat > 3 ? 'slow' : 'ok';
    $('#k-path').textContent = status;
    $('#k-path').className = 'v ' + (anyErr || state.pathLat >= 30 ? 'bad' : state.pathLat > 3 ? 'warn' : 'good');

    const monthly = rate * 3600 * 730;
    const pct = Math.min(100, (monthly / state.budget) * 100);
    $('#k-proj').textContent = '$' + monthly.toFixed(0);
    const bar = $('#budget-bar');
    bar.style.width = pct + '%';
    bar.className = pct > 100 ? 'bad' : pct > 70 ? 'warn' : '';
    $('#k-budget').textContent = '$' + state.budget.toLocaleString();
  }

  let drag = null, link = null, pan = null;

  function onNodeDown(ev) {
    if (ev.target.closest('.port')) return;
    ev.stopPropagation();
    const el = ev.target.closest('.node');
    const n = nodeById(el.dataset.id);
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
    if (link) {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = el && el.closest('.node');
      if (target && target.dataset.id !== link.from) addEdge(link.from, target.dataset.id);
      if (link.el) link.el.remove();
      link = null;
      compute(); render();
    }
    drag = null;
    pan = null;
  }

  function select(id) {
    state.sel = id;
    renderNodes();
    renderInspector();
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
    state.t = 0; state.spent = 0; state.chaos = {};
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
    state.chaos[k] = performance.now() / 1000 + dur;
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

  let lastReal = 0, acc = 0;
  function loop(ts) {
    if (!lastReal) lastReal = ts;
    const dtReal = Math.min(0.5, (ts - lastReal) / 1000);
    lastReal = ts;
    if (state.running) {
      const dtSim = dtReal * state.speed;
      state.t += dtSim;
      state.spent += state.rate * dtSim;
      compute();
      acc += dtReal;
      if (acc >= 0.22) {
        acc = 0;
        renderCost(); renderNodes(); renderAlerts();
      }
    }
    animateEdges(ts);
    requestAnimationFrame(loop);
  }

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);

  $('#search').addEventListener('input', renderPalette);
  $('#start').addEventListener('click', () => {
    state.running = !state.running;
    $('#start').textContent = state.running ? 'Pause simulation' : 'Start simulation';
    $('#start').classList.toggle('on', state.running);
    compute(); render();
  });
  $('#reset').addEventListener('click', () => {
    state.t = 0; state.spent = 0; state.chaos = {};
    compute(); render(); toast('Simulation reset');
  });
  function speedEq(v) {
    if (v < 60) return '1s = ' + v + 's';
    if (v < 3600) return '1s = ' + (Math.round(v / 6) / 10) + 'm';
    return '1s = ' + (Math.round(v / 360) / 10) + 'h';
  }
  $('#speed').addEventListener('input', e => {
    const v = parseInt(e.target.value, 10);
    if (!isNaN(v)) state.speed = Math.max(1, Math.min(7200, v));
    $('#speed-eq').innerHTML = '\u00d7 \u00b7 ' + speedEq(state.speed);
  });
  $('#speed-eq').innerHTML = '\u00d7 \u00b7 ' + speedEq(state.speed);
  $$('.chaos-btn').forEach(b => b.addEventListener('click', () => chaos(b.dataset.c)));
  $('#zoomin').addEventListener('click', () => { state.zoom = Math.min(1.8, state.zoom * 1.15); render(); });
  $('#zoomout').addEventListener('click', () => { state.zoom = Math.max(0.35, state.zoom / 1.15); render(); });
  $('#fit').addEventListener('click', fit);
  $('#budget').addEventListener('change', e => { state.budget = Math.max(1, parseFloat(e.target.value) || 1); renderCost(); });

  $('#canvas').addEventListener('pointerdown', ev => {
    if (ev.target.closest('.node')) return;
    pan = { sx: ev.clientX, sy: ev.clientY, px: state.px, py: state.py };
    state.sel = null; renderNodes(); renderInspector();
  });
  $('#canvas').addEventListener('wheel', ev => {
    ev.preventDefault();
    state.zoom = Math.max(0.35, Math.min(1.8, state.zoom * (ev.deltaY < 0 ? 1.08 : 0.93)));
    render();
  }, { passive: false });

  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
    if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (!state.sel) return;
    ev.preventDefault();
    state.nodes = state.nodes.filter(x => x.id !== state.sel);
    state.edges = state.edges.filter(e => e.from !== state.sel && e.to !== state.sel);
    state.sel = null;
    compute(); render();
  });

  let rz = null;
  const refit = () => { clearTimeout(rz); rz = setTimeout(() => fit(), 140); };
  window.addEventListener('resize', refit);
  if (window.ResizeObserver) new ResizeObserver(refit).observe($('#canvas'));

  const app = document.querySelector('.app');
  const toggle = (btn, cls) => {
    app.classList.toggle(cls);
    btn.classList.toggle('on', app.classList.contains(cls));
    refit();
  };
  $('#tog-pal').addEventListener('click', () => toggle($('#tog-pal'), 'no-pal'));
  $('#tog-insp').addEventListener('click', () => toggle($('#tog-insp'), 'no-insp'));
  if (window.innerWidth < 780) { app.classList.add('no-insp'); $('#tog-insp').classList.remove('on'); }

  renderPalette();
  loadTemplate();
  $('#budget').value = state.budget;
  requestAnimationFrame(loop);
})();
