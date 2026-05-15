import path from 'node:path';
import { PROVIDERS } from '../../modules/providers.js';
import { AcceptanceHarness, repoRoot } from './helpers.mjs';

const providerId = (process.env.REAL_PROVIDER || 'chatgpt').trim().toLowerCase();
const provider = PROVIDERS.find((item) => item.id === providerId);
const profileDir = process.env.CFT_PROFILE || path.join(repoRoot, 'dist/acceptance-real-profile');
const windowPosition = process.env.CFT_WINDOW_POSITION || '';

if (!provider) {
  throw new Error(`Unsupported REAL_PROVIDER "${providerId}". Expected one of: ${PROVIDERS.map((item) => item.id).join(', ')}`);
}

const chromeArgs = [];
if (/^-?\d+,-?\d+$/.test(windowPosition)) {
  chromeArgs.push(`--window-position=${windowPosition}`);
}

const harness = new AcceptanceHarness({
  useFakeProviders: false,
  profileDir,
  preserveProfile: true,
  chromeArgs
});

await harness.start();
const target = await harness.newPage(provider.url);
await harness.navigate(target, provider.url);
await harness.activateTarget(target.id);
await closeStartupBlankPages(target.id);

console.log(`real-provider setup opened: ${provider.name}`);
console.log(`profile: ${profileDir}`);
console.log(`debug: http://127.0.0.1:${harness.port}/json/list`);
console.log('Log in or pass any provider challenge in the opened Chrome window, then press Ctrl+C here to close it.');
console.log(`After setup, run: REAL_PROVIDER=${provider.id} npm run test:acceptance:real`);

await waitForShutdown();
await harness.stop();

function waitForShutdown() {
  return new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
}

async function closeStartupBlankPages(activeTargetId) {
  const targets = await harness.getTargets();
  for (const item of targets) {
    if (item.id !== activeTargetId && item.type === 'page' && item.url === 'about:blank') {
      await harness.closeTarget(item.id);
    }
  }
}
