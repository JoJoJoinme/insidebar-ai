import fs from 'node:fs';
import path from 'node:path';
import { AcceptanceHarness, assert, repoRoot } from './helpers.mjs';

const scenarioId = 'browser-env-storage-roundtrip';
const artifactRoot = path.join(repoRoot, 'dist/acceptance-artifacts-browser-env');
const harness = new AcceptanceHarness({
  artifactDir: artifactRoot
});

try {
  await harness.start();
  await runScenario();
  console.log(`browser-env smoke passed: ${scenarioId}`);
} finally {
  await harness.stop();
}

async function runScenario() {
  harness.beginScenario();
  try {
    const sentinelKey = `insidebarBrowserEnvSmoke_${Date.now()}`;
    const sentinelValue = `ok-${Math.random().toString(36).slice(2)}`;

    await harness.applySettings({ [sentinelKey]: sentinelValue });
    const syncValue = await harness.evaluate(
      harness.serviceWorker,
      storageGet('sync', { [sentinelKey]: null })
    );
    assert(
      syncValue?.[sentinelKey] === sentinelValue,
      `chrome.storage.sync roundtrip failed: ${JSON.stringify(syncValue)}`
    );

    const targets = await harness.getTargets();
    const startupNoise = targets.filter((target) =>
      target.type === 'page' &&
      /^(edge|chrome):\/\/sync-confirmation-dialog\//.test(target.url || '')
    );

    await writeArtifacts({
      scenarioId,
      state: startupNoise.length > 0 ? 'startup_noise_detected' : 'clean',
      timestamp: new Date().toISOString(),
      debugPort: harness.port,
      startupNoise: startupNoise.map((target) => ({
        id: target.id,
        type: target.type,
        url: target.url
      })),
      syncRoundtrip: {
        key: sentinelKey,
        passed: true
      }
    });
  } catch (error) {
    await harness.writeFailureArtifacts(scenarioId, error);
    throw error;
  } finally {
    await harness.endScenario();
  }
}

async function writeArtifacts(result) {
  const scenarioDir = path.join(artifactRoot, scenarioId);
  fs.mkdirSync(scenarioDir, { recursive: true });
  fs.writeFileSync(path.join(scenarioDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
}

function storageGet(area, value) {
  return `new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('chrome.storage.${area}.get timed out')), 3000);
    chrome.storage.${area}.get(${JSON.stringify(value)}, (result) => {
      clearTimeout(timeout);
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  })`;
}
