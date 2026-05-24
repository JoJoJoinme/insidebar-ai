import { spawnSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
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

console.log(`real-provider interactive opened: ${provider.name}`);
console.log(`profile: ${profileDir}`);
console.log('Log in or clear any provider challenge in the opened browser window.');

const rl = readline.createInterface({ input, output });
await rl.question('Press Enter here after the provider editor is usable...');
rl.close();

await harness.stop();

const result = spawnSync(process.execPath, [path.join(repoRoot, 'tests/acceptance/real-provider-ready.mjs')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    REAL_PROVIDER: providerId,
    CFT_PROFILE: profileDir,
    REQUIRE_EDITOR_READY: '1'
  },
  stdio: 'inherit'
});

process.exit(result.status ?? 1);

async function closeStartupBlankPages(activeTargetId) {
  const targets = await harness.getTargets();
  for (const item of targets) {
    if (item.id !== activeTargetId && item.type === 'page' && item.url === 'about:blank') {
      await harness.closeTarget(item.id);
    }
  }
}
