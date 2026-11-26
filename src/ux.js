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
    return !el.disabled && el.offsetParent !== null &&
      (el.tagName === 'SUMMARY' || !el.closest('details:not([open])'));
  }

  function bootstrapApply(pendingSave, dirty, booted) {
    if (pendingSave || dirty || booted) return 'identity';
    return 'apply';
  }

  const api = {
    saveStatus, nextTab, fieldProvenance, connectTargets, trapFocus, bannerError,
    sheetFocusable, bootstrapApply
  };
  root.UX = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
