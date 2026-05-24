import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const defaultChromeBin = '/root/.cache/puppeteer/chrome/linux-144.0.7559.96/chrome-linux64/chrome';

const PROVIDER_IDS = ['chatgpt', 'claude', 'gemini', 'google', 'grok', 'deepseek'];
const ACCEPTANCE_PROVIDER_MATCH = 'http://127.0.0.1/*';

export class AcceptanceHarness {
  constructor(options = {}) {
    this.chromeBin = options.chromeBin || process.env.CHROME_BIN || defaultChromeBin;
    const configuredPort = options.port ?? process.env.CFT_PORT;
    this.port = configuredPort == null ? 0 : Number(configuredPort);
    this.unpackedDir = options.unpackedDir || process.env.EXT_DIR || path.join(
      os.tmpdir(),
      `insidebar-ai-chrome-unpacked-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    this.profileDir = options.profileDir || process.env.CFT_PROFILE || path.join(os.tmpdir(), `insidebar-acceptance-${Date.now()}`);
    this.artifactDir = options.artifactDir || path.join(repoRoot, 'dist/acceptance-artifacts');
    this.fixtureDir = options.fixtureDir || path.join(repoRoot, 'tests/acceptance/fixtures');
    this.useFakeProviders = options.useFakeProviders !== false;
    this.providerModes = options.providerModes || {};
    this.preserveProfile = options.preserveProfile === true || process.env.ACCEPTANCE_PRESERVE_PROFILE === '1';
    this.chromeArgs = Array.isArray(options.chromeArgs) ? options.chromeArgs : readBrowserArgs();
    this.chromeProcess = null;
    this.fixtureServer = null;
    this.fixtureOrigin = null;
    this.providerOrigin = null;
    this.serviceWorker = null;
    this.page = null;
    this.sidebar = null;
    this.floating = null;
    this.scenarioTargetIds = new Set();
  }

  async start() {
    if (!fs.existsSync(this.chromeBin)) {
      throw new Error(`Chrome for Testing binary not found: ${this.chromeBin}`);
    }
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65535) {
      throw new Error(`Invalid Chrome debug port: ${this.port}`);
    }
    if (this.port === 0) {
      this.port = await findFreePort();
    }

    fs.mkdirSync(this.artifactDir, { recursive: true });
    if (!this.preserveProfile) {
      fs.rmSync(this.profileDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.profileDir, { recursive: true });
    await this.startFixtureServer();
    this.prepareUnpackedExtension();

    this.chromeProcess = spawn(this.chromeBin, [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      `--disable-extensions-except=${this.unpackedDir}`,
      `--load-extension=${this.unpackedDir}`,
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-features=EdgeSignIn,msEdgeSync,msImplicitSignin,msEdgeEnableNurturingFramework',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
      '--no-sandbox',
      '--disable-gpu',
      '--window-size=1365,960',
      ...this.chromeArgs,
      'about:blank'
    ], { stdio: 'ignore' });

    await this.waitForDebugEndpoint();
    this.serviceWorker = await this.waitForTarget((target) =>
      target.type === 'service_worker' && target.url.includes('/background/service-worker.js')
    );
    await this.closeBrowserStartupNoise();
  }

  async stop() {
    if (process.env.ACCEPTANCE_TRACE === '1') {
      console.log('harness stop: fixture server');
    }
    if (this.fixtureServer) {
      await Promise.race([
        new Promise((resolve) => this.fixtureServer.close(resolve)),
        delay(1200)
      ]);
    }
    if (process.env.ACCEPTANCE_TRACE === '1') {
      console.log('harness stop: chrome');
    }
    if (process.env.KEEP_CHROME !== '1') {
      await this.stopChrome();
    }
    if (process.env.ACCEPTANCE_TRACE === '1') {
      console.log('harness stop done');
    }
  }

  async applySettings(settings = {}) {
    await this.closeBrowserStartupNoise();
    if (process.env.ACCEPTANCE_TRACE === '1') console.log('apply settings: reset local pending');
    await this.evaluate(this.serviceWorker, storageCall('local', 'set', {
      pendingDockProvider: null,
      pendingProviderPrompt: null
    }));
    if (process.env.ACCEPTANCE_TRACE === '1') console.log('apply settings: reset side panel');
    await this.evaluate(this.serviceWorker, `globalThis.__insidebarResetSidePanelStateForTests?.()`);
    if (process.env.ACCEPTANCE_TRACE === '1') console.log('apply settings: sync set');
    await this.writeStorageValues('sync', settings);
    if (process.env.ACCEPTANCE_TRACE === '1') console.log('apply settings done');
  }

  async writeStorageValues(area, expectedValues) {
    const entries = Object.entries(expectedValues || {});
    if (entries.length === 0) {
      return;
    }

    const defaults = Object.fromEntries(entries.map(([key]) => [key, null]));
    const deadline = Date.now() + 12000;
    let lastValue = null;

    while (Date.now() < deadline) {
      await this.evaluate(this.serviceWorker, storageCall(area, 'set', expectedValues));
      lastValue = await this.evaluate(this.serviceWorker, storageGetCall(area, defaults));
      if (entries.every(([key, expected]) => JSON.stringify(lastValue?.[key]) === JSON.stringify(expected))) {
        return;
      }
      await delay(350);
    }

    throw new Error(`Timed out waiting for chrome.storage.${area} settings readback: ${JSON.stringify(lastValue)}`);
  }

  async closeBrowserStartupNoise() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const targets = await this.getTargets();
      const noisyTargets = targets.filter((target) =>
        target.type === 'page' &&
        /^(edge|chrome):\/\/sync-confirmation-dialog\//.test(target.url || '')
      );

      if (noisyTargets.length === 0) {
        return;
      }

      for (const target of noisyTargets) {
        await Promise.race([
          this.closePageTarget(target),
          delay(1200)
        ]);
        await this.closeTarget(target.id);
      }
      await delay(300);
    }
  }

  async closePageTarget(target) {
    try {
      const client = await connect(target);
      await client.send('Page.close');
      client.close();
    } catch {
      await this.closeTarget(target.id);
    }
  }

  beginScenario() {
    this.page = null;
    this.sidebar = null;
    this.floating = null;
    this.scenarioTargetIds.clear();
  }

  async endScenario() {
    const targetIds = Array.from(this.scenarioTargetIds).reverse();
    for (const targetId of targetIds) {
      await Promise.race([
        this.closeTarget(targetId),
        delay(1200)
      ]);
    }
    this.scenarioTargetIds.clear();
    this.page = null;
    this.sidebar = null;
    this.floating = null;
  }

  fixtureUrl(fileName) {
    return `${this.fixtureOrigin}/${fileName}`;
  }

  async openFixture(fileName) {
    const url = this.fixtureUrl(fileName);
    const target = await this.newPage(url);
    this.page = target;
    this.trackTarget(target);
    await this.navigate(target, url);
    return target;
  }

  async selectText(testId) {
    return this.evaluate(this.page, `(async () => {
      const source = document.querySelector('[data-testid="${escapeForSelector(testId)}"]');
      if (!source) throw new Error('Selectable fixture element not found: ${escapeJs(testId)}');
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const rect = range.getBoundingClientRect();
      document.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        clientX: Math.max(10, Math.min(window.innerWidth - 10, rect.left + 20)),
        clientY: Math.max(10, Math.min(window.innerHeight - 10, rect.top + 20))
      }));
      await new Promise((resolve) => setTimeout(resolve, 600));
      const toolbar = document.querySelector('[data-testid="selection-toolbar"]');
      return {
        selectionLength: selection.toString().trim().length,
        toolbarVisible: !!toolbar && !toolbar.hidden
      };
    })()`);
  }

  async clickToolbarAction(actionName) {
    const action = actionName.toLowerCase();
    await this.clickByTestId(this.page, `selection-toolbar-${action}`);
    await delay(250);
  }

  async waitForFloating() {
    await this.evaluate(this.page, `(async () => {
      await waitFor(() => {
        const floating = document.querySelector('[data-testid="floating-window"]');
        return floating && !floating.hidden;
      }, 10000);

      function waitFor(predicate, timeout) {
        const started = Date.now();
        return new Promise((resolve, reject) => {
          const tick = () => {
            if (predicate()) {
              resolve();
              return;
            }
            if (Date.now() - started > timeout) {
              reject(new Error('Timed out waiting for floating window'));
              return;
            }
            setTimeout(tick, 150);
          };
          tick();
        });
      }
    })()`);
    this.floating = await this.resolveFloatingTarget();
  }

  async submitAskQuestion(question, options = {}) {
    await this.evaluate(this.page, `(async () => {
      const panel = document.querySelector('[data-testid="selection-ask-panel"]');
      if (!panel || panel.hidden) {
        throw new Error('Ask panel is not visible');
      }
      const input = document.querySelector('[data-testid="selection-ask-input"]');
      const send = document.querySelector('[data-testid="selection-ask-send"]');
      if (!input || !send) {
        throw new Error('Ask panel input or send button not found');
      }
      input.value = ${JSON.stringify(question)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      send.click();
    })()`);
    if (options.waitForFloating !== false) {
      await this.waitForFloating();
    } else {
      await delay(250);
    }
  }

  async switchFloatingProvider(provider) {
    this.floating ||= await this.resolveFloatingTarget();
    await this.evaluate(this.floating, `(async () => {
      const button = document.querySelector('[data-testid="floating-provider-tab-${escapeForSelector(provider)}"]');
      if (!button) throw new Error('Floating provider tab not found: ${escapeJs(provider)}');
      button.click();
      await waitFor(() => document.querySelector('[data-testid="floating-provider-tabs"]')?.dataset.activeProvider === '${escapeJs(provider)}', 10000);

      function waitFor(predicate, timeout) {
        const started = Date.now();
        return new Promise((resolve, reject) => {
          const tick = () => {
            if (predicate()) {
              resolve();
              return;
            }
            if (Date.now() - started > timeout) {
              reject(new Error('Timed out waiting for floating provider'));
              return;
            }
            setTimeout(tick, 150);
          };
          tick();
        });
      }
    })()`);
  }

  async closeFloating() {
    await this.clickByTestId(this.page, 'floating-close');
    await delay(250);
  }

  async setSelectionToolbarOpenMode(openMode) {
    await this.evaluate(this.serviceWorker, storageCall('sync', 'set', {
      selectionToolbarOpenMode: openMode
    }));
    await delay(400);
  }

  async dockFloating() {
    await this.clickByTestId(this.page, 'floating-dock');
    this.sidebar = await this.waitForTarget((target) =>
      target.type === 'page' && target.url.includes('/sidebar/sidebar.html')
    );
    this.trackTarget(this.sidebar);
  }

  async readToolbarState() {
    return this.evaluate(this.page, `(() => {
      const toolbar = document.querySelector('[data-testid="selection-toolbar"]');
      return {
        visible: !!toolbar && !toolbar.hidden,
        openMode: toolbar?.dataset.openMode || null,
        settingsLoaded: toolbar?.dataset.settingsLoaded || null
      };
    })()`);
  }

  async readAskPanelState() {
    return this.evaluate(this.page, `(() => {
      const panel = document.querySelector('[data-testid="selection-ask-panel"]');
      const quote = document.querySelector('[data-testid="selection-ask-quote-text"]');
      return {
        visible: !!panel && !panel.hidden,
        quoteText: quote?.textContent.trim() || ''
      };
    })()`);
  }

  async readOuterFloatingState() {
    return this.evaluate(this.page, `(() => {
      const floating = document.querySelector('[data-testid="floating-window"]');
      return {
        visible: !!floating && !floating.hidden,
        activeProvider: floating?.dataset.activeProvider || null,
        controls: Array.from(document.querySelectorAll('[data-testid="floating-window"] button[data-testid]'))
          .map((button) => button.dataset.testid)
      };
    })()`);
  }

  async readOuterFloatingHiddenState() {
    return this.evaluate(this.page, `(() => {
      const floating = document.querySelector('[data-testid="floating-window"]');
      return {
        exists: !!floating,
        hidden: !floating || floating.hidden
      };
    })()`);
  }

  async readFloatingLayout() {
    this.floating ||= await this.resolveFloatingTarget();
    return this.waitForEvaluation(this.floating, `(() => {
      const shell = document.querySelector('[data-testid="floating-provider-shell"]');
      const tabs = document.querySelector('[data-testid="floating-provider-tabs"]');
      const iframe = document.querySelector('[data-testid="floating-provider-frame"]');
      return {
        innerHeight,
        shell: rect(shell),
        tabs: rect(tabs),
        iframe: rect(iframe),
        tabsText: tabs?.textContent.trim() || '',
        providerTitles: Array.from(tabs?.querySelectorAll('button') || []).map((button) => button.title),
        activeProvider: tabs?.dataset.activeProvider || null
      };

      function rect(element) {
        if (!element) return null;
        const r = element.getBoundingClientRect();
        return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
      }
    })()`, (value) => !!value?.shell && !!value?.tabs && value.tabs.height > 0, 10000, 'floating provider layout');
  }

  async readFloatingReference() {
    this.floating ||= await this.resolveFloatingTarget();
    return this.evaluate(this.floating, `(() => {
      const question = document.querySelector('[data-testid="floating-reference-question"]');
      const text = document.querySelector('[data-testid="floating-reference-text"]');
      return {
        question: question?.textContent.trim() || '',
        text: text?.textContent.trim() || ''
      };
    })()`);
  }

  async readFloatingInjectionState() {
    this.floating ||= await this.resolveFloatingTarget();
    return this.waitForEvaluation(this.floating, `(() => ({
      autoSubmit: document.body.dataset.lastAutoSubmit || null,
      promptLength: Number(document.body.dataset.lastPromptLength || 0)
    }))()`, (value) => value?.autoSubmit !== null, 10000, 'floating prompt injection state');
  }

  async readFloatingAuthHelper() {
    this.floating ||= await this.resolveFloatingTarget();
    return this.waitForEvaluation(this.floating, `(() => {
      const helper = document.querySelector('[data-testid="floating-auth-helper"]');
      const button = document.querySelector('[data-testid="floating-open-provider-tab"]');
      return {
        visible: !!helper && !helper.hidden,
        providerId: helper?.dataset.providerId || null,
        text: helper?.textContent.trim() || '',
        buttonText: button?.textContent.trim() || ''
      };
    })()`, (value) => value?.visible, 10000, 'floating auth helper');
  }

  async readEmbeddedProviderLayout(provider) {
    const floatingTarget = await this.resolveFloatingTarget();
    const providerFrame = await this.resolveProviderFrameTarget(provider, floatingTarget);
    return this.waitForEvaluation(providerFrame, `(() => {
      const header = document.querySelector('header');
      return {
        hasLayoutStyle: !!document.getElementById('insidebar-embedded-provider-layout'),
        headerDisplay: header ? getComputedStyle(header).display : null
      };
    })()`, (value) => value.hasLayoutStyle && value.headerDisplay === 'none', 8000, `embedded ${provider} layout`);
  }

  async readProviderInjectionState(provider, options = {}) {
    const floatingTarget = await this.resolveFloatingTarget();
    return this.waitForProviderInjectionState(
      provider,
      floatingTarget,
      options,
      `fake ${provider} provider injection state`
    );
  }

  async readSidebarProviderInjectionState(provider, options = {}) {
    const sidebarTarget = await this.resolveSidebarTarget();
    return this.waitForProviderInjectionState(
      provider,
      sidebarTarget,
      options,
      `sidebar fake ${provider} provider injection state`
    );
  }

  async readEmbeddedChatgptLayout() {
    const floatingTarget = await this.resolveFloatingTarget();
    const chatgptFrame = await this.waitForTarget(
      (target) =>
        target.type === 'iframe' &&
        target.parentId === floatingTarget.id &&
        target.url.startsWith('https://chatgpt.com/'),
      15000,
      'ChatGPT iframe'
    );
    return this.waitForEvaluation(chatgptFrame, `(() => {
      const header = document.querySelector('header');
      return {
        hasLayoutStyle: !!document.getElementById('insidebar-embedded-provider-layout'),
        headerDisplay: header ? getComputedStyle(header).display : null
      };
    })()`, (value) => value.hasLayoutStyle && value.headerDisplay === 'none', 8000, 'embedded ChatGPT layout');
  }

  async readStorageProvider() {
    const value = await this.evaluate(this.serviceWorker, `chrome.storage.sync.get({ lastSelectedProvider: 'chatgpt' })`);
    return value.lastSelectedProvider;
  }

  async readSidebarState() {
    this.sidebar ||= await this.resolveSidebarTarget();
    return this.waitForEvaluation(this.sidebar, `(() => {
      const tabs = document.querySelector('[data-testid="sidebar-provider-tabs"]');
      const container = document.querySelector('[data-testid="sidebar-provider-container"]');
      const providerFrame = container?.querySelector('iframe:not([style*="display: none"])');
      return {
        activeProvider: tabs?.dataset.activeProvider || null,
        providerVisible: container ? getComputedStyle(container).display : null,
        providerFrameUrl: providerFrame?.src || '',
        bottomTestIds: Array.from(tabs?.querySelectorAll('button[data-testid]') || [])
          .map((button) => button.dataset.testid)
      };
    })()`, (value) => value?.activeProvider && value.providerVisible === 'flex', 10000, 'sidebar provider state');
  }

  async writeFailureArtifacts(scenarioId, error) {
    const dir = path.join(this.artifactDir, scenarioId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'error.txt'), `${error.stack || error.message}\n`);

    try {
      fs.writeFileSync(path.join(dir, 'targets.json'), JSON.stringify(await this.getTargets(), null, 2));
    } catch {
      // ignore artifact failures
    }

    try {
      const storage = await this.evaluate(this.serviceWorker, `chrome.storage.sync.get(null)`);
      fs.writeFileSync(path.join(dir, 'storage.json'), JSON.stringify(storage, null, 2));
    } catch {
      // ignore artifact failures
    }

    if (this.page) {
      try {
        await this.captureScreenshot(this.page, path.join(dir, 'page.png'));
      } catch {
        // ignore artifact failures
      }
      try {
        const contracts = await this.evaluate(this.page, `(() => Array.from(document.querySelectorAll('[data-testid]')).map((element) => ({
          tag: element.tagName,
          testid: element.dataset.testid,
          hidden: element.hidden,
          text: element.textContent.trim().slice(0, 120),
          rect: (() => {
            const r = element.getBoundingClientRect();
            return { top: r.top, left: r.left, width: r.width, height: r.height };
          })()
        })))()`);
        fs.writeFileSync(path.join(dir, 'page-contracts.json'), JSON.stringify(contracts, null, 2));
      } catch {
        // ignore artifact failures
      }
    }

    if (this.floating) {
      try {
        await this.captureScreenshot(this.floating, path.join(dir, 'floating.png'));
      } catch {
        // ignore artifact failures
      }
      try {
        const contracts = await this.readContracts(this.floating);
        fs.writeFileSync(path.join(dir, 'floating-contracts.json'), JSON.stringify(contracts, null, 2));
      } catch {
        // ignore artifact failures
      }
    }

    if (this.sidebar) {
      try {
        await this.captureScreenshot(this.sidebar, path.join(dir, 'sidebar.png'));
      } catch {
        // ignore artifact failures
      }
      try {
        const contracts = await this.readContracts(this.sidebar);
        fs.writeFileSync(path.join(dir, 'sidebar-contracts.json'), JSON.stringify(contracts, null, 2));
      } catch {
        // ignore artifact failures
      }
    }
  }

  prepareUnpackedExtension() {
    fs.rmSync(this.unpackedDir, { recursive: true, force: true });
    fs.mkdirSync(this.unpackedDir, { recursive: true });
    const excluded = new Set(['.git', 'dist', 'node_modules', 'tests']);
    for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
      if (excluded.has(entry.name)) {
        continue;
      }
      fs.cpSync(path.join(repoRoot, entry.name), path.join(this.unpackedDir, entry.name), {
        recursive: true
      });
    }
    if (this.useFakeProviders) {
      this.patchAcceptanceExtension();
    }
  }

  patchAcceptanceExtension() {
    this.patchManifestForFakeProviders();
    this.patchProviderUrls();
    this.patchTextInjectionProviderDetection();
  }

  patchManifestForFakeProviders() {
    const manifestPath = path.join(this.unpackedDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const alreadyPatched = manifest.content_scripts.some((entry) =>
      entry.matches?.includes(ACCEPTANCE_PROVIDER_MATCH) &&
      entry.js?.includes('content-scripts/text-injection-all-providers.js')
    );

    if (!alreadyPatched) {
      manifest.content_scripts.push({
        matches: [ACCEPTANCE_PROVIDER_MATCH],
        js: ['content-scripts/text-injection-all-providers.js'],
        run_at: 'document_start',
        all_frames: true
      });
    }

    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  patchProviderUrls() {
    const providersPath = path.join(this.unpackedDir, 'modules/providers.js');
    let source = fs.readFileSync(providersPath, 'utf8');

    for (const providerId of PROVIDER_IDS) {
      const pattern = new RegExp(`(id:\\s*'${providerId}'[\\s\\S]*?url:\\s*)'[^']+'`);
      const nextSource = source.replace(pattern, `$1'${this.fakeProviderUrl(providerId)}'`);
      if (nextSource === source) {
        throw new Error(`Unable to patch fake acceptance URL for provider: ${providerId}`);
      }
      source = nextSource;
    }

    fs.writeFileSync(providersPath, source);
  }

  patchTextInjectionProviderDetection() {
    const scriptPath = path.join(this.unpackedDir, 'content-scripts/text-injection-all-providers.js');
    let source = fs.readFileSync(scriptPath, 'utf8');
    const needle = `    const hostname = window.location.hostname;\n    if (hostname.includes('chatgpt.com') || hostname.includes('openai.com')) {`;
    const replacement = `    const acceptanceProvider = new URLSearchParams(window.location.search).get('provider');\n    if (window.location.hostname === '127.0.0.1' && PROVIDER_SELECTORS[acceptanceProvider]) {\n      PROVIDER_SELECTORS[acceptanceProvider] = [\n        '[data-testid=\"fake-provider-input\"]',\n        ...(PROVIDER_SELECTORS[acceptanceProvider] || [])\n      ];\n      return acceptanceProvider;\n    }\n\n    const hostname = window.location.hostname;\n    if (hostname.includes('chatgpt.com') || hostname.includes('openai.com')) {`;

    if (!source.includes(needle)) {
      throw new Error('Unable to patch fake provider detection in text injection script');
    }

    fs.writeFileSync(scriptPath, source.replace(needle, replacement));
  }

  fakeProviderUrl(providerId) {
    const mode = this.providerModes[providerId] || 'editor-ready';
    return `${this.providerOrigin}/fake-provider.html?provider=${encodeURIComponent(providerId)}&mode=${encodeURIComponent(mode)}`;
  }

  async startFixtureServer() {
    this.fixtureServer = http.createServer((request, response) => {
      const requestedPath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const normalized = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, '');
      const filePath = path.join(this.fixtureDir, normalized === '/' ? 'article-page.html' : normalized);
      if (!filePath.startsWith(this.fixtureDir) || !fs.existsSync(filePath)) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }
      response.writeHead(200, { 'content-type': contentType(filePath) });
      response.end(fs.readFileSync(filePath));
    });

    await new Promise((resolve) => this.fixtureServer.listen(0, '127.0.0.1', resolve));
    const address = this.fixtureServer.address();
    this.fixtureOrigin = `http://127.0.0.1:${address.port}`;
    this.providerOrigin = this.fixtureOrigin;
  }

  async waitForDebugEndpoint() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/json/version`);
        if (response.ok) return;
      } catch {
        // keep waiting
      }
      await delay(250);
    }
    throw new Error(`Chrome debug endpoint did not start on port ${this.port}`);
  }

  async newPage(url) {
    const response = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT'
    });
    if (!response.ok) {
      throw new Error(`Failed to open page: ${response.status}`);
    }
    return response.json();
  }

  async getTargets() {
    const response = await fetch(`http://127.0.0.1:${this.port}/json/list`);
    return response.json();
  }

  async waitForTarget(predicate, timeout = 15000, label = 'CDP target') {
    const deadline = Date.now() + timeout;
    let lastTargets = [];
    while (Date.now() < deadline) {
      lastTargets = await this.getTargets();
      const matches = lastTargets.filter(predicate);
      const target = matches[matches.length - 1] || null;
      if (target) return target;
      await delay(250);
    }
    throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(lastTargets.map((target) => ({
      id: target.id,
      type: target.type,
      parentId: target.parentId,
      url: target.url
    })))}`);
  }

  async resolveFloatingTarget() {
    const pageId = this.page?.id;
    this.floating ||= await this.waitForTarget(
      (target) =>
        target.type === 'iframe' &&
        target.url.includes('/floating/floating.html') &&
        (!pageId || target.parentId === pageId),
      15000,
      'floating iframe'
    );
    this.trackTarget(this.floating);
    return this.floating;
  }

  async resolveSidebarTarget() {
    this.sidebar ||= await this.waitForTarget(
      (target) => target.type === 'page' && target.url.includes('/sidebar/sidebar.html'),
      15000,
      'sidebar page'
    );
    this.trackTarget(this.sidebar);
    return this.sidebar;
  }

  async resolveProviderFrameTarget(provider, floatingTarget = null) {
    const matches = await this.resolveProviderFrameTargets(provider, floatingTarget);
    return matches[0] || null;
  }

  async resolveProviderFrameTargets(provider, floatingTarget = null) {
    const parent = floatingTarget || await this.resolveFloatingTarget();
    const isMatch = (target) =>
      target.type === 'iframe' &&
      target.parentId === parent.id &&
      target.url.includes('/fake-provider.html') &&
      target.url.includes(`provider=${encodeURIComponent(provider)}`);

    await this.waitForTarget(isMatch, 15000, `${provider} fake provider iframe`);
    const targets = await this.getTargets();
    const matches = targets.filter(isMatch).reverse();
    for (const target of matches) {
      this.trackTarget(target);
    }
    return matches;
  }

  async waitForProviderInjectionState(provider, parentTarget, options = {}, label = 'fake provider injection state') {
    const deadline = Date.now() + 10000;
    let lastStates = [];

    while (Date.now() < deadline) {
      const frames = await this.resolveProviderFrameTargets(provider, parentTarget);
      lastStates = [];

      for (const frame of frames) {
        try {
          const state = await this.evaluate(frame, `(() => {
            const input = document.querySelector('[data-testid="fake-provider-input"]');
            const inputValue = input?.value || input?.textContent || '';
            return {
              inputValue,
              inputLength: inputValue.length,
              messageAutoSubmit: document.body.dataset.lastMessageAutoSubmit || null,
              messageLength: Number(document.body.dataset.lastMessageTextLength || 0),
              submitCount: Number(document.body.dataset.submitCount || 0),
              submittedText: document.body.dataset.submittedText || ''
            };
          })()`);
          lastStates.push({ targetId: frame.id, ...state });
          if (state?.inputLength > 0 && (!options.waitForSubmit || state.submitCount > 0)) {
            return state;
          }
        } catch (error) {
          lastStates.push({ targetId: frame.id, error: error?.message || String(error) });
        }
      }

      await delay(250);
    }

    throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(lastStates)}`);
  }

  trackTarget(target) {
    if (target?.id) {
      this.scenarioTargetIds.add(target.id);
    }
  }

  async closeTarget(targetId) {
    if (!targetId) {
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    try {
      await fetch(`http://127.0.0.1:${this.port}/json/close/${targetId}`, {
        signal: controller.signal
      });
    } catch {
      // ignore cleanup failures
    } finally {
      clearTimeout(timeout);
    }
  }

  async activateTarget(targetId) {
    if (!targetId) {
      return;
    }
    try {
      await fetch(`http://127.0.0.1:${this.port}/json/activate/${targetId}`);
    } catch {
      // Best effort only; iframe targets may not be directly activatable.
    }
  }

  async navigate(target, url) {
    const client = await connect(target);
    await client.send('Page.enable');
    await client.send('Page.navigate', { url });
    client.close();
    await delay(2000);
  }

  async evaluate(target, expression) {
    const client = await connect(target);
    await client.send('Runtime.enable');
    const response = await client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    client.close();
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Runtime exception');
    }
    return response.result?.result?.value;
  }

  async waitForEvaluation(target, expression, predicate, timeout = 10000, label = 'evaluation') {
    const deadline = Date.now() + timeout;
    let lastValue = null;
    while (Date.now() < deadline) {
      lastValue = await this.evaluate(target, expression);
      if (predicate(lastValue)) {
        return lastValue;
      }
      await delay(250);
    }
    throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(lastValue)}`);
  }

  async clickByTestId(target, testId) {
    await this.activateTarget(target.id);
    await delay(100);
    const point = await this.evaluate(target, `(() => {
      const element = document.querySelector('[data-testid="${escapeForSelector(testId)}"]');
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    assert(point, `Element not found: ${testId}`);

    const client = await connect(target);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    client.close();
  }

  async captureScreenshot(target, filePath) {
    const client = await connect(target);
    const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    client.close();
    fs.writeFileSync(filePath, Buffer.from(screenshot.result.data, 'base64'));
  }

  async readContracts(target) {
    return this.evaluate(target, `(() => Array.from(document.querySelectorAll('[data-testid]')).map((element) => ({
      tag: element.tagName,
      testid: element.dataset.testid,
      hidden: element.hidden,
      text: element.textContent.trim().slice(0, 120),
      rect: (() => {
        const r = element.getBoundingClientRect();
        return { top: r.top, left: r.left, width: r.width, height: r.height };
      })()
    })))()`);
  }

  async stopChrome() {
    if (!this.chromeProcess || this.chromeProcess.exitCode !== null) {
      return;
    }

    const exited = new Promise((resolve) => {
      this.chromeProcess.once('exit', resolve);
    });
    this.chromeProcess.kill('SIGTERM');

    const didExit = await Promise.race([
      exited.then(() => true),
      delay(3000).then(() => false)
    ]);

    if (!didExit && this.chromeProcess.exitCode === null) {
      this.chromeProcess.kill('SIGKILL');
      await exited;
    }
  }
}

async function connect(target) {
  let id = 0;
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return {
    send(method, params = {}) {
      const callId = ++id;
      socket.send(JSON.stringify({ id: callId, method, params }));
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(callId);
          reject(new Error(`CDP command timed out: ${method}`));
        }, 10000);
        pending.set(callId, (message) => {
          clearTimeout(timeout);
          resolve(message);
        });
      });
    },
    close() {
      socket.close();
    }
  };
}

export function assert(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

export function assertIncludes(values, expected) {
  assert(values.includes(expected), `expected ${JSON.stringify(values)} to include ${expected}`);
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function readBrowserArgs() {
  const raw = process.env.CFT_BROWSER_ARGS;
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed;
    }
  } catch {
    // Fall back to a simple delimiter format below.
  }

  return raw.split('|').map((item) => item.trim()).filter(Boolean);
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function storageCall(area, method, value = null) {
  const args = value == null ? '' : `${JSON.stringify(value)}, `;
  return `new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('chrome.storage.${area}.${method} timed out')), 3000);
    chrome.storage.${area}.${method}(${args}() => {
      clearTimeout(timeout);
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(true);
    });
  })`;
}

function storageGetCall(area, defaults) {
  return `new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('chrome.storage.${area}.get timed out')), 3000);
    chrome.storage.${area}.get(${JSON.stringify(defaults)}, (value) => {
      clearTimeout(timeout);
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(value);
    });
  })`;
}

function escapeJs(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function escapeForSelector(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
