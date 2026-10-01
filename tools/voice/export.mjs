// Writes tools/voice/units.json: every line KeySplash can say with the built-in
// voice, taken from src/voice/inventory.ts (loaded through Vite's SSR loader so
// the TypeScript sources are the single source of truth).
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const outFile = resolve(here, 'units.json');
// Optional override (debugging): node tools/voice/export.mjs path/to/inventory.ts
const modulePath = process.argv[2] ? '/@fs/' + resolve(process.argv[2]).replace(/^\//, '') : '/src/voice/inventory.ts';

const server = await createServer({
  root,
  configFile: false, // the app config (PWA plugin etc.) is irrelevant here
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] }, // no browser deps scan (it trips on virtual:pwa-register)
  logLevel: 'error',
});

try {
  const mod = await server.ssrLoadModule(modulePath);
  if (typeof mod.allVoiceUnits !== 'function') {
    throw new Error(`${modulePath} does not export allVoiceUnits()`);
  }
  const byKey = new Map();
  for (const unit of mod.allVoiceUnits()) {
    const { key, tts } = unit ?? {};
    if (typeof key !== 'string' || typeof tts !== 'string' || !key || !tts.trim()) {
      throw new Error(`bad voice unit: ${JSON.stringify(unit)}`);
    }
    const prev = byKey.get(key);
    if (prev !== undefined && prev !== tts) {
      throw new Error(`key "${key}" has two different tts texts: "${prev}" vs "${tts}"`);
    }
    byKey.set(key, tts);
  }
  // Stable order → clean diffs and deterministic generation.
  const units = [...byKey]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, tts]) => ({ key, tts }));
  await writeFile(outFile, JSON.stringify(units, null, 2) + '\n');
  console.log(`voice: wrote ${units.length} units → ${outFile}`);
} finally {
  await server.close();
}
