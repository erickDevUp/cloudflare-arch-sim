window.CATALOG = {
  groups: [
    { id: 'edge', label: 'Traffic & Edge', color: '#7c5cff' },
    { id: 'compute', label: 'Compute', color: '#00c2a8' },
    { id: 'data', label: 'Data', color: '#3b82f6' },
    { id: 'ai', label: 'AI', color: '#e11d48' },
    { id: 'external', label: 'External', color: '#f59e0b' }
  ],
  types: {
    traffic: {
      name: 'Traffic', group: 'edge', icon: 'activity', source: true,
      p: { rate: 40, concurrency: 0, latency: 0, price: 0, units: 1 },
      fields: ['rate'],
      note: 'Request arrivals. Everything downstream is driven by this.'
    },
    dns: {
      name: 'DNS', group: 'edge', icon: 'globe',
      p: { concurrency: 1000000, latency: 8, price: 0, units: 1 },
      note: 'Authoritative resolution, no charge at this layer.'
    },
    waf: {
      name: 'WAF', group: 'edge', icon: 'shield',
      p: { concurrency: 1000000, latency: 3, price: 0, units: 1 },
      note: 'Managed rules run before your code. No per-request charge.'
    },
    turnstile: {
      name: 'Turnstile', group: 'edge', icon: 'shield-check',
      p: { concurrency: 1000000, latency: 25, price: 0, units: 1 },
      note: 'Bot token check at the edge. Free, and it keeps junk out of the model.'
    },
    cache: {
      name: 'Cache', group: 'edge', icon: 'layers',
      p: { concurrency: 1000000, latency: 2, price: 0, units: 1, hit: 60 },
      fields: ['hit'],
      note: 'Cache offload: downstream only sees (1 - hit) of the traffic.'
    },
    workers: {
      name: 'Workers', group: 'compute', icon: 'zap',
      p: { concurrency: 1000, latency: 6, price: 0.30, units: 1, cpuMs: 6 },
      fields: ['concurrency', 'latency', 'cpuMs'],
      priceCpu: 0.02,
      verified: '10M req/mo included, then $0.30/M. 30M CPU-ms included, then $0.02/M. CPU is billed per millisecond actually executed, so JSON parsing and crypto land here, not in the request count.',
      doc: 'https://developers.cloudflare.com/workers/platform/pricing/'
    },
    durable_objects: {
      name: 'Durable Objects', group: 'compute', icon: 'box',
      p: { concurrency: 1000, latency: 20, price: 0.15, units: 1, priceGBs: 12.5 },
      fields: ['concurrency'],
      verified: '$0.15/M requests, $12.50/M GB-s. Soft limit ~1,000 req/s per object; scale with more objects, not more load on one.',
      doc: 'https://developers.cloudflare.com/durable-objects/platform/pricing/'
    },
    queues: {
      name: 'Queues', group: 'compute', icon: 'list-ordered',
      p: { concurrency: 50, latency: 10, price: 0.4, units: 1 },
      note: 'Absorbs bursts and retries. Price varies by operations: treat it as editable.'
    },
    d1: {
      name: 'D1', group: 'data', icon: 'database',
      p: { concurrency: 50, latency: 60, price: 0.001, units: 25 },
      fields: ['units'],
      verified: '25B rows read/mo included then $0.001/M. 50M rows written included then $1.00/M. One primary per database.',
      doc: 'https://developers.cloudflare.com/d1/platform/pricing/'
    },
    kv: {
      name: 'KV', group: 'data', icon: 'key-round',
      p: { concurrency: 1000000, latency: 5, price: 0.2, units: 1 },
      note: 'Read-heavy, eventually consistent. Reads are cheap, writes are not.'
    },
    r2: {
      name: 'R2', group: 'data', icon: 'archive',
      p: { concurrency: 1000000, latency: 30, price: 0.36, units: 1 },
      note: 'Objects by key, no egress fee. Price per operation is an assumption here.'
    },
    vectorize: {
      name: 'Vectorize', group: 'data', icon: 'scan-search',
      p: { concurrency: 50, latency: 80, price: 0, units: 1 },
      note: 'Vector query with metadata filters. Paid plan only; per-query cost left at 0, editable.'
    },
    ai_gateway: {
      name: 'AI Gateway', group: 'ai', icon: 'route',
      p: { concurrency: 1000000, latency: 4, price: 0, units: 1 },
      note: 'No charge for the gateway itself. It buys you caching, rate limits and logs, not capacity.'
    },
    workers_ai: {
      name: 'Model', group: 'ai', icon: 'sparkles',
      p: { concurrency: 24, latency: 900, price: 0.3, units: 7000,
        inPrice: null, outPrice: null, inTokens: null, outTokens: null },
      fields: ['concurrency', 'latency', 'units', 'inPrice', 'outPrice', 'inTokens', 'outTokens'],
      note: 'Concurrency is the scarce resource: this is the provider tier, not the edge. Tokens per request drive both latency and cost. Token prices below are the external model price and stay out of the Cloudflare bill.'
    },
    external: {
      name: 'Tiendanube API', group: 'external', icon: 'plug',
      p: { concurrency: 1, latency: 500, price: 0, units: 1 },
      fields: ['concurrency', 'latency'],
      verified: 'Leaky bucket of 2 req/s with burst of 40, per store and app. One shared server model = a hard wall.',
      doc: 'https://tiendanube.github.io/api-documentation/intro'
    }
  }
};
