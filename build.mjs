import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const src = path.join(root, 'src');
const read = f => fs.readFileSync(path.join(src, f), 'utf8');

const iconNames = ['activity', 'globe', 'shield', 'shield-check', 'layers', 'zap', 'box',
  'list-ordered', 'database', 'key-round', 'archive', 'scan-search', 'route', 'sparkles', 'plug',
  'image', 'video'];

const icons = {};
for (const name of iconNames) {
  const file = path.join(root, 'node_modules', 'lucide-static', 'icons', `${name}.svg`);
  const raw = fs.readFileSync(file, 'utf8');
  const inner = raw.slice(raw.indexOf('>') + 1, raw.lastIndexOf('</svg>')).replace(/\s+/g, ' ').trim();
  icons[name] = inner;
}

let html = read('index.html');
html = html.replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${read('styles.css')}\n</style>`);
html = html.replace('<script src="pricing.js"></script>', () => `<script>\n${read('pricing.js')}\n</script>`);
html = html.replace('<script src="catalog.js"></script>',
  () => `<script>\nwindow.ICONS = ${JSON.stringify(icons)};\n</script>\n<script>\n${read('catalog.js')}\n</script>`);
html = html.replace('<script src="scenario.js"></script>', () => `<script>\n${read('scenario.js')}\n</script>`);
html = html.replace('<script src="engine.js"></script>', () => `<script>\n${read('engine.js')}\n</script>`);

const flag = process.argv.indexOf('--scenario');
const scenarioFile = flag >= 0 ? process.argv[flag + 1] : null;
if (scenarioFile) {
  const raw = fs.readFileSync(path.resolve(scenarioFile), 'utf8');
  JSON.parse(raw); // fail the build on a broken scenario file
  const embedded = raw.replace(/</g, '\\u003c');
  html = html.replace('<script src="app.js"></script>',
    () => `<script>\nwindow.__SCENARIO__ = ${embedded};\n</script>\n<script>\n${read('app.js')}\n</script>`);
} else {
  html = html.replace('<script src="app.js"></script>', () => `<script>\n${read('app.js')}\n</script>`);
}

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'cloudflare-arch-sim.html');
fs.writeFileSync(out, html);
console.log(`${out}  ${(html.length / 1024).toFixed(1)} KB  ${iconNames.length} icons${scenarioFile ? '  scenario: ' + scenarioFile : ''}`);
