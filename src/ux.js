(function (root) {
  const VERIFIED_DEFAULTS = new Set([
    'price', 'priceGBs', 'priceRowRead', 'priceRowWritten', 'priceStoredGb',
    'priceClassA', 'priceStorage', 'pricePerThousand', 'priceStored',
    'priceDelivered', 'storagePrice', 'deliveryPricePerThousand', 'retention',
    'neuronsIn', 'neuronsOut'
  ]);

  function saveStatus(event) {
    switch (event.type) {
      case 'local': return { phase: 'local', message: 'Local only', retryable: false };
      case 'checking': return { phase: 'saving', message: 'Checking live channel…', retryable: false };
      case 'saving': return { phase: 'saving', message: 'Saving scenario…', retryable: false };
      case 'saved': return { phase: 'saved', message: 'All changes saved', retryable: false };
      case 'unsaved': return { phase: 'unsaved', message: 'Unsaved changes', retryable: false };
      case 'rejected': return { phase: 'error', message: 'Scenario not saved: ' + event.message, retryable: false };
      case 'http': return {
        phase: 'error',
        message: 'Save failed (HTTP ' + event.status + '). Your changes remain in this tab.',
        retryable: event.status !== 400
      };
      case 'network': return {
        phase: 'error',
        message: 'Network error. Your changes remain in this tab.',
        retryable: true
      };
      case 'disconnected': return {
        phase: 'error',
        message: 'Live updates disconnected. Your changes remain in this tab.',
        retryable: true
      };
      case 'unavailable': return {
        phase: 'error',
        message: 'Scenario channel unavailable (HTTP ' + event.status + ').',
        retryable: true
      };
      default: return { phase: 'local', message: 'Local only', retryable: false };
    }
  }

  function nextTab(current, key, tabs) {
    const index = tabs.indexOf(current);
    if (index < 0) return tabs[0];
    if (key === 'Home') return tabs[0];
    if (key === 'End') return tabs[tabs.length - 1];
    if (key === 'ArrowRight') return tabs[(index + 1) % tabs.length];
    if (key === 'ArrowLeft') return tabs[(index - 1 + tabs.length) % tabs.length];
    return current;
  }

  function fieldProvenance(def, field) {
    if (def && def.verified && VERIFIED_DEFAULTS.has(field)) {
      return { kind: 'verified', label: 'Verified default · editable' };
    }
    return { kind: 'assumption', label: 'Editable assumption' };
  }

  /**
   * @param {string | number} value
   * @param {number} min
   * @param {number} [max]
   * @returns {number | null}
   */
  function parseDecimalInput(value, min, max = Infinity) {
    const text = String(value).trim();
    if (!text || (text.includes(',') && text.includes('.'))) return null;
    const normalized = text.replace(',', '.');
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return null;
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
    return parsed;
  }

  function userCapacity(res, usage, requestsPerUserPerMonth) {
    if (!res || res.plan === 'custom' || !usage || !(usage.workersRequests > 0) ||
        !(requestsPerUserPerMonth > 0) || !Array.isArray(res.lines)) return null;
    const first = res.lines.filter(l => l.period !== 'per request' && l.used > 0)
      .reduce((a, l) => {
        const limit = l.limit != null ? l.limit : l.included;
        const ratio = limit > 0 ? l.used / limit : 0;
        return !a || ratio > a.ratio ? { label: l.label, limit, used: l.used, ratio } : a;
      }, null);
    if (!first || !(first.limit > 0)) return null;
    const perReq = first.used / usage.workersRequests;
    const total = Math.floor(usage.workersRequests / requestsPerUserPerMonth);
    if (!(perReq > 0) || !(total > 0)) return null;
    const includedUsers = Math.floor(first.limit / perReq / requestsPerUserPerMonth);
    const base = Math.min(total, includedUsers);
    return { base, extra: total - base, total, label: first.label, limit: first.limit };
  }

  function connectTargets(nodes, fromId) {
    return nodes.filter(n => n.id !== fromId).map(n => ({
      id: n.id,
      label: n.alias || (root.CATALOG && root.CATALOG.types[n.type] && root.CATALOG.types[n.type].name) || n.type
    }));
  }

  const GUIDE_STEPS = [
    { label: 'Entrada', title: 'Tráfico de entrada', types: ['traffic'], tip: 'La tasa de entrada gobierna todo el diagrama. Cambia la fuente antes de ajustar capacidades para no optimizar el cuello de botella equivocado.' },
    { label: 'Borde', title: 'Borde y caché', types: ['dns', 'waf', 'turnstile', 'cache'], tip: 'La caché sólo reenvía los misses. Un hit alto reduce carga, pero no elimina el costo de las peticiones que sí llegan al origen.' },
    { label: 'Worker', title: 'Worker y concurrencia', types: ['workers'], tip: 'La utilización combina llegadas, servicio y concurrencia. Sostenida por encima del 90%, la latencia y los errores empiezan a dominar.' },
    { label: 'Agente', title: 'Agente y objetos', types: ['durable_objects'], tip: 'Los Durable Objects reparten las llegadas entre objetos. Más objetos ayudan al sharding; no borran el costo de duración, filas o WebSockets.' },
    { label: 'Datos', title: 'Almacenamiento y datos', types: ['d1', 'kv', 'r2', 'images', 'stream', 'vectorize'], tip: 'Separa lecturas, escrituras, almacenamiento y entrega. Son dimensiones distintas y no deben mezclarse en una única tasa de CPU.' },
    { label: 'Modelo', title: 'Inferencia y modelos', types: ['ai_gateway', 'workers_ai', 'external_model'], tip: 'Workers AI entra en el bill de Cloudflare; los modelos externos mantienen su gasto separado. Tokens y Neuronas no son la misma unidad.' },
    { label: 'Salida', title: 'Cola y salida', types: ['queues', 'external'], tip: 'Sólo Queue limita la salida a su capacidad. El exceso forma backlog y puede vencer la retención; una API externa también puede convertirse en un muro compartido.' }
  ];

  function phaseForType(type) {
    if (type === 'traffic') return 0;
    if (['dns', 'waf', 'turnstile', 'cache'].includes(type)) return 1;
    if (type === 'workers') return 2;
    if (type === 'durable_objects') return 3;
    if (['d1', 'kv', 'r2', 'images', 'stream', 'vectorize'].includes(type)) return 4;
    if (['ai_gateway', 'workers_ai', 'external_model'].includes(type)) return 5;
    return 6;
  }

  function guideContent(index, view) {
    const safeIndex = Math.max(0, Math.min(GUIDE_STEPS.length - 1, Number(index) || 0));
    const step = GUIDE_STEPS[safeIndex];
    const nodes = (view.nodes || []).filter(n => step.types.includes(n.type));
    const metrics = nodes.map(n => n.r || {});
    const rate = nodes.reduce((peak, n) => Math.max(peak, Number(n.r && n.r.lambda) || 0), 0);
    const peakUtil = metrics.reduce((peak, r) => Math.max(peak, Number(r.util) || 0), 0);
    const peakLatency = metrics.reduce((peak, r) => Math.max(peak, Number(r.lat) || 0), 0);
    const errors = metrics.reduce((sum, r) => sum + (Number(r.err) || 0), 0);
    const backlog = metrics.reduce((sum, r) => sum + (Number(r.backlog) || 0), 0);
    const drops = metrics.reduce((sum, r) => sum + (Number(r.drops) || 0), 0);
    let issue = '';
    let caseText = '';

    if (safeIndex === 0) {
      const sourceRate = Number(view.sourceRate) || 0;
      const requests = Math.round(Number(view.requests) || 0);
      if (!(sourceRate > 0)) issue = 'No hay tráfico de entrada activo.';
      caseText = sourceRate > 0
        ? sourceRate.toFixed(1) + ' req/s entran al modelo y ya se acumularon ' + requests.toLocaleString() + ' peticiones.'
        : 'Añade un nodo Traffic para observar cómo se propaga la carga.';
    } else if (safeIndex === 1) {
      const cache = nodes.find(n => n.type === 'cache');
      if (!nodes.length) issue = 'Esta fase no tiene componentes en el diagrama.';
      caseText = cache
        ? 'La caché está al ' + Math.round(Number(cache.p && cache.p.hit) || 0) + '% de hit y el borde observa ' + rate.toFixed(1) + ' req/s.'
        : nodes.length ? nodes.length + ' componentes de borde observan ' + rate.toFixed(1) + ' req/s.' : 'Añade DNS, WAF, Turnstile o Cache para construir esta fase.';
    } else if (safeIndex === 2) {
      if (!nodes.length) issue = 'No hay un Worker que ejecute la petición.';
      else if (peakUtil >= 0.9 || errors > 0) issue = 'El Worker está cerca de saturación o devuelve errores.';
      caseText = nodes.length
        ? 'El Worker más carado está al ' + Math.round(peakUtil * 100) + '% de utilización; el camino crítico tarda ' + Math.round((Number(view.pathLat) || 0) * 1000) + ' ms.'
        : 'Añade Workers para medir servicio, concurrencia y CPU.';
    } else if (safeIndex === 3) {
      const objects = nodes.reduce((sum, n) => sum + (Number(n.p && n.p.objects) || 1), 0);
      if (!nodes.length) issue = 'No hay estado coordinado por Durable Objects.';
      else if (peakUtil >= 0.9 || errors > 0 || nodes.some(n => n.r && n.r.overloaded)) issue = 'Un objeto está sobrecargado o devolviendo errores.';
      caseText = nodes.length
        ? objects.toLocaleString() + ' objeto(s) coordinan ' + rate.toFixed(1) + ' req/s con una utilización máxima de ' + Math.round(peakUtil * 100) + '%.'
        : 'Añade Durable Objects cuando la petición necesite estado o coordinación.';
    } else if (safeIndex === 4) {
      if (!nodes.length) issue = 'No hay una capa de datos conectada.';
      else if (peakUtil >= 1 || errors > 0) issue = 'Una operación de datos está saturada o fallando.';
      caseText = nodes.length
        ? nodes.length + ' servicio(s) de datos procesan ' + rate.toFixed(1) + ' req/s; la latencia máxima es ' + Math.round(peakLatency * 1000) + ' ms.'
        : 'Añade D1, R2, KV, Images, Stream o Vectorize según la dimensión que quieras medir.';
    } else if (safeIndex === 5) {
      const missingModel = nodes.some(n => n.type === 'external_model' && (!n.p || [n.p.inPrice, n.p.outPrice, n.p.inTokens, n.p.outTokens].some(v => v == null)));
      if (!nodes.length) issue = 'No hay una fase de inferencia en el modelo.';
      else if (missingModel) issue = 'Faltan precios o tokens del modelo externo.';
      else if (peakUtil >= 1 || errors > 0) issue = 'La inferencia está saturada o devolviendo errores.';
      caseText = nodes.length
        ? 'La inferencia recibe ' + rate.toFixed(1) + ' req/s. ' + (view.modelSet ? 'El gasto externo está configurado y separado.' : 'No hay gasto externo configurado; Workers AI sigue en Cloudflare.')
        : 'Añade AI Gateway, Workers AI o un modelo externo para evaluar esta fase.';
    } else {
      if (!nodes.length) issue = 'No hay una salida o cola en el diagrama.';
      else if (backlog > 0 || drops > 0 || errors > 0 || peakUtil >= 1) issue = 'La salida tiene backlog, expiración, errores o saturación.';
      caseText = nodes.length
        ? 'La salida observa ' + rate.toFixed(1) + ' req/s, ' + Math.round(backlog).toLocaleString() + ' mensajes en backlog y ' + drops.toFixed(1) + ' drops/s.'
        : 'Añade Queue o una API externa para observar capacidad y retención.';
    }

    return {
      index: safeIndex,
      step: safeIndex + 1,
      total: GUIDE_STEPS.length,
      label: step.label,
      title: step.title,
      tip: step.tip,
      status: issue ? 'PROBLEMA' : 'OK',
      problem: !!issue,
      issue,
      caseText,
      checklist: [
        { label: 'Componentes de ' + step.label + ' presentes', checked: nodes.length > 0 },
        { label: 'Métricas del modelo disponibles', checked: nodes.length > 0 && metrics.some(r => Number.isFinite(Number(r.lambda))) },
        { label: 'Sin alertas críticas en esta fase', checked: !issue }
      ]
    };
  }

  function guideChanges(baseline, current) {
    if (!baseline || (Number(current.time) || 0) < (Number(baseline.time) || 0)) {
      return { reset: true, seconds: 0, requests: 0, cloudflare: 0, model: 0 };
    }
    return {
      reset: false,
      seconds: Math.max(0, (Number(current.time) || 0) - (Number(baseline.time) || 0)),
      requests: Math.max(0, (Number(current.requests) || 0) - (Number(baseline.requests) || 0)),
      cloudflare: Math.max(0, (Number(current.spent) || 0) - (Number(baseline.spent) || 0)),
      model: Math.max(0, (Number(current.modelSpent) || 0) - (Number(baseline.modelSpent) || 0))
    };
  }

  function trapFocus(active, shiftKey, focusable) {
    if (!focusable.length) return null;
    const index = focusable.indexOf(active);
    if (index < 0) return shiftKey ? focusable[focusable.length - 1] : focusable[0];
    const step = shiftKey ? -1 : 1;
    return focusable[(index + step + focusable.length) % focusable.length];
  }

  function bannerError(errors) {
    return errors && (errors.channel || errors.save || errors.copy) || null;
  }

  function sheetFocusable(el) {
    return !el.disabled && el.tabIndex >= 0 && el.offsetParent !== null &&
      (el.tagName === 'SUMMARY' || !el.closest('details:not([open])'));
  }

  const api = {
    saveStatus, nextTab, fieldProvenance, parseDecimalInput, userCapacity,
    connectTargets, phaseForType, guideContent, guideChanges, trapFocus, bannerError, sheetFocusable
  };
  root.UX = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
