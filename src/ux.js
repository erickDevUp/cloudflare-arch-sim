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
    connectTargets, trapFocus, bannerError, sheetFocusable
  };
  root.UX = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
