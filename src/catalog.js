(function (root, factory) {
  const catalog = factory();
  if (typeof module === 'object' && module.exports) module.exports = catalog;
  if (root) root.CATALOG = catalog;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const data = {
  groups: [
    { id: 'edge', label: 'Traffic & Edge', color: '#7c5cff' },
    { id: 'compute', label: 'Compute', color: '#00c2a8' },
    { id: 'data', label: 'Data', color: '#3b82f6' },
    { id: 'ai', label: 'AI', color: '#e11d48' },
    { id: 'external', label: 'External', color: '#f59e0b' }
  ],
  // One source of truth for editable bounds: [min, max, step]. The inspector
  // and the scenario validator both read this table so they cannot drift.
  ranges: {
    rate: [1, 100000, 1],
    concurrency: [1, 1000000, 1],
    latency: [0, 60000, 1],
    retention: [0, 2592000, 3600],
    price: [0, 100, 0.001],
    units: [0, 100000, 1],
    hit: [0, 100, 1],
    priceGBs: [0, 100, 0.01],
    cpuMs: [0, 30000, 0.5],
    inPrice: [0, 1000, 0.01],
    outPrice: [0, 1000, 0.01],
    inTokens: [0, 1000000, 1],
    outTokens: [0, 1000000, 1],
    objects: [1, 1000000, 1],
    connections: [0, 1000000, 1],
    activePct: [0, 100, 1],
    activeMs: [0, 60000, 0.5],
    activeSeconds: [0, 1000000000, 1],
    rowsRead: [0, 1000000, 1],
    rowsWritten: [0, 1000000, 1],
    storedGb: [0, 1000000, 0.1],
    classAUnits: [0, 100000, 1],
    priceClassA: [0, 100, 0.001],
    priceStorage: [0, 100, 0.001],
    priceRowRead: [0, 100, 0.001],
    priceRowWritten: [0, 100, 0.001],
    priceStoredGb: [0, 100, 0.001],
    uniqueTransforms: [0, 1000000000, 1],
    imagesStored: [0, 1000000000, 1],
    imagesDelivered: [0, 1000000000, 1],
    pricePerThousand: [0, 1000, 0.01],
    priceStored: [0, 1000, 0.01],
    priceDelivered: [0, 1000, 0.01],
    minutesStored: [0, 1000000000, 1],
    minutesDelivered: [0, 1000000000, 1],
    storagePrice: [0, 1000, 0.01],
    deliveryPricePerThousand: [0, 1000, 0.01],
    neuronsIn: [0, 1000000000, 1],
    neuronsOut: [0, 1000000000, 1]
  },
  enums: {
    transport: ['http', 'rpc', 'websocket', 'hibernatable']
  },
  types: {
    traffic: {
      name: 'Traffic', group: 'edge', icon: 'activity', source: true,
      p: { rate: 40, concurrency: 1, latency: 0, price: 0, units: 1 },
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
      p: { concurrency: 1000, latency: 20, price: 0.15, units: 1, priceGBs: 12.5,
        objects: 1, transport: 'http', connections: 0, activePct: 100, activeMs: 20, activeSeconds: 0,
        rowsRead: 0, rowsWritten: 0, storedGb: 0,
        priceRowRead: 0.001, priceRowWritten: 1, priceStoredGb: 0.2 },
      fields: ['concurrency', 'latency', 'objects', 'transport', 'connections', 'activePct', 'activeMs', 'activeSeconds', 'rowsRead', 'rowsWritten', 'storedGb'],
      note: 'Object count spreads arrivals evenly. HTTP/RPC duration derives from service time unless active wall-clock seconds are set; non-hibernatable WebSockets use the connected window. Hibernatable WebSockets use actual incoming messages × active milliseconds, capped by each object\'s available wall time. SQLite rows are per incoming message and stored GB is total.',
      verified: '$0.15/M requests, $12.50/M GB-s. SQLite rows and stored data are billed separately. Soft limit ~1,000 req/s per object. WebSocket incoming messages bill 20:1; non-hibernatable connections bill for their connected window, while hibernatable messages bill only active time.',
      doc: 'https://developers.cloudflare.com/durable-objects/platform/pricing/'
    },
    queues: {
      name: 'Queues', group: 'compute', icon: 'list-ordered',
      p: { concurrency: 50, latency: 10, retention: 345600, price: 0.4, units: 1 },
      fields: ['concurrency', 'latency', 'retention'],
      verified: 'Normally 3 operations per message: write, read and delete. Paid retention defaults to 4 days and can reach 14 days. Throughput is capped at 5,000 messages/s and push consumers at 250 concurrent invocations.',
      note: 'Throttles downstream to forward capacity; the rest builds a backlog. Zero capacity retains everything and uses the retention horizon as its wait. Messages older than retention expire. Assumption: FIFO, one deterministic service rate and no retries.',
      doc: 'https://developers.cloudflare.com/queues/platform/pricing/'
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
      p: { concurrency: 1000000, latency: 5, price: 0.5, units: 1 },
      note: 'Read-heavy, eventually consistent. Reads are cheap, writes are not.'
    },
    r2: {
      name: 'R2', group: 'data', icon: 'archive',
      p: { concurrency: 1000000, latency: 30, price: 0.36, units: 1,
        classAUnits: 0, storageGb: 0, priceClassA: 4.5, priceStorage: 0.015 },
      fields: ['units', 'classAUnits', 'storageGb'],
      verified: 'Standard storage $0.015/GB-month, Class A $4.50/M and Class B $0.36/M. Monthly free tier: 10 GB, 1M Class A and 10M Class B operations. Delete operations and egress are free.',
      note: 'Units per request default to Class B reads. Class A units cover writes and lists; stored GB is a monthly provisioned amount.',
      doc: 'https://developers.cloudflare.com/r2/pricing/'
    },
    images: {
      name: 'Images', group: 'data', icon: 'image',
      p: { concurrency: 1000000, latency: 40, uniqueTransforms: 0, imagesStored: 0, imagesDelivered: 0,
        pricePerThousand: 0.5, priceStored: 5, priceDelivered: 1 },
      fields: ['uniqueTransforms', 'imagesStored', 'imagesDelivered'],
      verified: 'Paid: first 5,000 unique transformations included, then $0.50/1,000. Images stored cost $5/100,000 and delivered images $1/100,000.',
      note: 'Monthly dimensions, not per-request charges. Repeated requests for the same source and transformation count once. Stored and delivered metrics apply only to images stored in Images.',
      doc: 'https://developers.cloudflare.com/images/pricing/'
    },
    stream: {
      name: 'Stream', group: 'data', icon: 'video',
      p: { concurrency: 1000000, latency: 50, minutesStored: 0, minutesDelivered: 0,
        storagePrice: 5, deliveryPricePerThousand: 1 },
      fields: ['minutesStored', 'minutesDelivered'],
      verified: 'Storage is prepaid in $5 increments per 1,000 minutes. Delivery is $1/1,000 minutes; ingress and encoding are free.',
      note: 'Monthly video-minute dimensions. Storage capacity rounds up to the next 1,000 minutes; delivery uses total minutes watched.',
      doc: 'https://developers.cloudflare.com/stream/pricing/'
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
      name: 'Workers AI', group: 'ai', icon: 'sparkles',
      p: { concurrency: 24, latency: 900, inTokens: 1000, outTokens: 500, neuronsIn: 4625, neuronsOut: 30475 },
      fields: ['concurrency', 'latency', 'inTokens', 'outTokens', 'neuronsIn', 'neuronsOut'],
      priceNeurons: 0.011,
      verified: 'Cloudflare Neuron spend: $0.011/1,000 Neurons above 10,000/day. Defaults use @cf/meta/llama-3.2-3b-instruct: 4,625 input and 30,475 output Neurons per million tokens.',
      note: 'Native Cloudflare inference. Neuron usage enters Cloudflare spend, never the external model bucket.',
      doc: 'https://developers.cloudflare.com/workers-ai/platform/pricing/'
    },
    external_model: {
      name: 'External model', group: 'external', icon: 'plug', cloudflare: false,
      p: { concurrency: 24, latency: 900, inPrice: null, outPrice: null, inTokens: null, outTokens: null },
      fields: ['concurrency', 'latency', 'inPrice', 'outPrice', 'inTokens', 'outTokens'],
      note: 'Third-party inference. Token prices stay in Model spend and never enter the Cloudflare bill.'
    },
    external: {
      name: 'Tiendanube API', group: 'external', icon: 'plug', cloudflare: false,
      p: { concurrency: 1, latency: 500, price: 0, units: 1 },
      fields: ['concurrency', 'latency'],
      verified: 'Leaky bucket of 2 req/s with burst of 40, per store and app. One shared server model = a hard wall.',
      doc: 'https://tiendanube.github.io/api-documentation/intro'
    }
  }
  };
  return data;
});
