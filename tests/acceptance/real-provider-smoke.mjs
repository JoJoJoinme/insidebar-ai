import fs from 'node:fs';
import path from 'node:path';
import { AcceptanceHarness, assert, repoRoot } from './helpers.mjs';

const PROVIDER_CONFIG = {
  chatgpt: {
    hosts: ['chatgpt.com', 'chat.openai.com'],
    selectors: ['#prompt-textarea', 'textarea[data-testid="prompt-textarea"]'],
    expectedSnippet: 'Industry produced over 90 percent of notable frontier AI models'
  },
  claude: {
    hosts: ['claude.ai'],
    selectors: ['.ProseMirror[role="textbox"]', '.ProseMirror[contenteditable="true"]'],
    expectedSnippet: 'Industry produced over 90 percent of notable frontier AI models'
  },
  gemini: {
    hosts: ['gemini.google.com'],
    selectors: ['.ql-editor'],
    expectedSnippet: 'Industry produced over 90 percent of notable frontier AI models'
  },
  google: {
    hosts: ['www.google.com', 'google.com'],
    selectors: ['textarea.ITIRGe', 'textarea[aria-label="Ask anything"]', 'textarea[maxlength="8192"]'],
    expectedSnippet: 'Industry produced over 90 percent of notable frontier AI models'
  },
  grok: {
    hosts: ['grok.com'],
    selectors: ['textarea', '.tiptap', '.ProseMirror'],
    expectedSnippet: 'Industry produced over 90 percent of notable frontier AI models'
  },
  deepseek: {
    hosts: ['chat.deepseek.com', 'deepseek.com'],
    selectors: ['textarea.ds-scroll-area'],
    expectedSnippet: 'Industry produced over 90 percent of notable frontier AI models'
  }
};

const providerId = (process.env.REAL_PROVIDER || 'chatgpt').trim().toLowerCase();
const providerConfig = PROVIDER_CONFIG[providerId];
const scenarioId = `real-provider-${providerId}-editor-ready`;
const profileDir = process.env.CFT_PROFILE || path.join(repoRoot, 'dist/acceptance-real-profile');

if (!providerConfig) {
  throw new Error(`Unsupported REAL_PROVIDER "${providerId}". Expected one of: ${Object.keys(PROVIDER_CONFIG).join(', ')}`);
}

const artifactRoot = path.join(repoRoot, 'dist/acceptance-artifacts-real');
const harness = new AcceptanceHarness({
  useFakeProviders: false,
  artifactDir: artifactRoot,
  profileDir,
  preserveProfile: true
});

try {
  await harness.start();
  const result = await runScenario();
  console.log(`real-provider smoke ${result.state}: ${scenarioId}`);
} finally {
  await harness.stop();
}

async function runScenario() {
  harness.beginScenario();
  try {
    await harness.applySettings({
      selectionToolbarOpenMode: 'floating',
      lastSelectedProvider: providerId,
      rememberLastProvider: true,
      enabledProviders: ['chatgpt', 'claude', 'gemini', 'google', 'grok', 'deepseek']
    });

    await harness.openFixture('article-page.html');
    const selection = await harness.selectText('mainParagraph');
    assert(selection.selectionLength > 30, `Expected non-empty selection, got ${JSON.stringify(selection)}`);

    await harness.clickToolbarAction('Send');
    await harness.waitForFloating();
    const floatingTarget = await harness.resolveFloatingTarget();

    const providerFrame = await harness.waitForTarget(
      (target) =>
        target.type === 'iframe' &&
        target.parentId === floatingTarget.id &&
        providerConfig.hosts.some((host) => target.url.includes(host)),
      40000,
      `${providerId} real provider iframe`
    );

    const editorReady = await harness.waitForEvaluation(
      providerFrame,
      `(() => {
        const selectors = ${JSON.stringify(providerConfig.selectors)};
        const matchedSelector = selectors.find((selector) => {
          try {
            return !!document.querySelector(selector);
          } catch {
            return false;
          }
        }) || null;
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const authWallDetected = /log in|login|sign in|continue with|create account/.test(bodyText);
        const blockedByChallenge = /unusual traffic|captcha|sorry\\//.test(bodyText) || window.location.href.includes('/sorry/');
        return {
          matchedSelector,
          authWallDetected,
          blockedByChallenge,
          url: window.location.href,
          title: document.title || ''
        };
      })()`,
      (value) =>
        !!value?.matchedSelector ||
        value?.authWallDetected === true ||
        value?.blockedByChallenge === true,
      40000,
      `${providerId} editor readiness`
    );

    if (!editorReady.matchedSelector) {
      const state = editorReady.blockedByChallenge ? 'anti_bot_blocked' : 'auth_required';
      await writeSuccessArtifacts({
        scenarioId,
        state,
        providerId,
        timestamp: new Date().toISOString(),
        providerFrameUrl: providerFrame.url,
        readiness: editorReady
      }, providerFrame, floatingTarget);
      return { state };
    }

    const promptState = await harness.waitForEvaluation(
      providerFrame,
      `(() => {
        const selectors = ${JSON.stringify(providerConfig.selectors)};
        let promptText = '';
        let matchedSelector = null;
        for (const selector of selectors) {
          let element = null;
          try {
            element = document.querySelector(selector);
          } catch {
            element = null;
          }
          if (!element) {
            continue;
          }
          matchedSelector = selector;
          promptText = typeof element.value === 'string' ? element.value : (element.textContent || '');
          if (promptText.length > 0) {
            break;
          }
        }
        return {
          matchedSelector,
          promptText,
          promptLength: promptText.length
        };
      })()`,
      (value) => (value?.promptLength || 0) >= 80,
      25000,
      `${providerId} prompt injection`
    );

    assert(
      promptState.promptText.includes(providerConfig.expectedSnippet),
      `${providerId} prompt missing expected selected text snippet`
    );
    assert(
      !promptState.promptText.includes('Source: http://127.0.0.1'),
      `${providerId} prompt leaked local source URL`
    );

    await writeSuccessArtifacts({
      scenarioId,
      state: 'editor_ready',
      providerId,
      timestamp: new Date().toISOString(),
      providerFrameUrl: providerFrame.url,
      matchedSelector: promptState.matchedSelector,
      promptLength: promptState.promptLength
    }, providerFrame, floatingTarget);
    return { state: 'editor_ready' };
  } catch (error) {
    await harness.writeFailureArtifacts(scenarioId, error);
    throw error;
  } finally {
    await harness.endScenario();
  }
}

async function writeSuccessArtifacts(result, providerFrame, floatingTarget) {
  const scenarioDir = path.join(artifactRoot, scenarioId);
  fs.mkdirSync(scenarioDir, { recursive: true });
  fs.writeFileSync(path.join(scenarioDir, 'success.json'), `${JSON.stringify(result, null, 2)}\n`);

  try {
    await harness.captureScreenshot(harness.page, path.join(scenarioDir, 'page.png'));
  } catch {
    // ignore screenshot failure
  }

  try {
    await harness.captureScreenshot(floatingTarget, path.join(scenarioDir, 'floating.png'));
  } catch {
    // ignore screenshot failure
  }

  try {
    await harness.captureScreenshot(providerFrame, path.join(scenarioDir, 'provider.png'));
  } catch {
    // ignore screenshot failure
  }
}
