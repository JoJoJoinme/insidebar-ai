import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const defaultChromeBin = '/root/.cache/puppeteer/chrome/linux-144.0.7559.96/chrome-linux64/chrome';

export class AcceptanceHarness {
  constructor(options = {}) {
    this.chromeBin = options.chromeBin || process.env.CHROME_BIN || defaultChromeBin;
    this.port = Number(options.port || process.env.CFT_PORT || 9394);
    this.unpackedDir = options.unpackedDir || process.env.EXT_DIR || path.join(repoRoot, 'dist/insidebar-ai-chrome-unpacked');
    this.profileDir = options.profileDir || process.env.CFT_PROFILE || path.join(os.tmpdir(), `insidebar-acceptance-${Date.now()}`);
    this.artifactDir = options.artifactDir || path.join(repoRoot, 'dist/acceptance-artifacts');
    this.fixtureDir = options.fixtureDir || path.join(repoRoot, 'tests/acceptance/fixtures');
    this.chromeProcess = null;
    this.fixtureServer = null;
    this.fixtureOrigin = null;
    this.serviceWorker = null;
    this.page = null;
    this.sidebar = null;
    this.floating = null;
  }

  async start() {
    if (!fs.existsSync(this.chromeBin)) {
      throw new Error(`Chrome for Testing binary not found: ${this.chromeBin}`);
    }

    this.prepareUnpackedExtension();
    fs.mkdirSync(this.artifactDir, { recursive: true });
    fs.rmSync(this.profileDir, { recursive: true, force: true });
    fs.mkdirSync(this.profileDir, { recursive: true });
    await this.startFixtureServer();

    this.chromeProcess = spawn(this.chromeBin, [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      `--disable-extensions-except=${this.unpackedDir}`,
      `--load-extension=${this.unpackedDir}`,
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-gpu',
      '--window-size=1365,960',
      'about:blank'
    ], { stdio: 'ignore' });

    await this.waitForDebugEndpoint();
    this.serviceWorker = await this.waitForTarget((target) =>
      target.type === 'service_worker' && target.url.includes('/background/service-worker.js')
    );
  }

  async stop() {
    await new Promise((resolve) => this.fixtureServer?.close(resolve));
    if (process.env.KEEP_CHROME !== '1') {
      this.chromeProcess?.kill('SIGTERM');
    }
  }

  async applySettings(settings = {}) {
    await this.evaluate(this.serviceWorker, `chrome.storage.sync.set(${JSON.stringify(settings)})`);
  }

  fixtureUrl(fileName) {
    return `${this.fixtureOrigin}/${fileName}`;
  }

  async openFixture(fileName) {
    const url = this.fixtureUrl(fileName);
    const target = await this.newPage(url);
    this.page = target;
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
    await this.evaluate(this.page, `(async () => {
      const button = document.querySelector('[data-testid="selection-toolbar-${escapeForSelector(action)}"]');
      if (!button) throw new Error('Toolbar action not found: ${escapeJs(actionName)}');
      button.click();
      await waitFor(() => {
        const floating = document.querySelector('[data-testid="floating-window"]');
        return floating && !floating.hidden;
      }, 8000);

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
    this.floating = await this.waitForTarget((target) =>
      target.type === 'iframe' && target.url.includes('/floating/floating.html')
    );
  }

  async switchFloatingProvider(provider) {
    this.floating ||= await this.waitForTarget((target) =>
      target.type === 'iframe' && target.url.includes('/floating/floating.html')
    );
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

  async dockFloating() {
    await this.clickByTestId(this.page, 'floating-dock');
    this.sidebar = await this.waitForTarget((target) =>
      target.type === 'page' && target.url.includes('/sidebar/sidebar.html')
    );
  }

  async readToolbarState() {
    return this.evaluate(this.page, `(() => {
      const toolbar = document.querySelector('[data-testid="selection-toolbar"]');
      return { visible: !!toolbar && !toolbar.hidden };
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

  async readFloatingLayout() {
    this.floating ||= await this.waitForTarget((target) =>
      target.type === 'iframe' && target.url.includes('/floating/floating.html')
    );
    return this.evaluate(this.floating, `(() => {
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
    })()`);
  }

  async readEmbeddedChatgptLayout() {
    const chatgptFrame = await this.waitForTarget((target) =>
      target.type === 'iframe' && target.url.startsWith('https://chatgpt.com/')
    );
    return this.waitForEvaluation(chatgptFrame, `(() => {
      const header = document.querySelector('header');
      return {
        hasLayoutStyle: !!document.getElementById('insidebar-embedded-provider-layout'),
        headerDisplay: header ? getComputedStyle(header).display : null
      };
    })()`, (value) => value.hasLayoutStyle && value.headerDisplay === 'none', 8000);
  }

  async readStorageProvider() {
    const value = await this.evaluate(this.serviceWorker, `chrome.storage.sync.get({ lastSelectedProvider: 'chatgpt' })`);
    return value.lastSelectedProvider;
  }

  async readSidebarState() {
    this.sidebar ||= await this.waitForTarget((target) =>
      target.type === 'page' && target.url.includes('/sidebar/sidebar.html')
    );
    return this.waitForEvaluation(this.sidebar, `(() => {
      const tabs = document.querySelector('[data-testid="sidebar-provider-tabs"]');
      const container = document.querySelector('[data-testid="sidebar-provider-container"]');
      return {
        activeProvider: tabs?.dataset.activeProvider || null,
        providerVisible: container ? getComputedStyle(container).display : null,
        bottomTestIds: Array.from(tabs?.querySelectorAll('button[data-testid]') || [])
          .map((button) => button.dataset.testid)
      };
    })()`, (value) => value?.activeProvider && value.providerVisible === 'flex', 10000);
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

  async waitForTarget(predicate, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const targets = await this.getTargets();
      const target = targets.find(predicate);
      if (target) return target;
      await delay(250);
    }
    throw new Error('Timed out waiting for CDP target');
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

  async waitForEvaluation(target, expression, predicate, timeout = 10000) {
    const deadline = Date.now() + timeout;
    let lastValue = null;
    while (Date.now() < deadline) {
      lastValue = await this.evaluate(target, expression);
      if (predicate(lastValue)) {
        return lastValue;
      }
      await delay(250);
    }
    return lastValue;
  }

  async clickByTestId(target, testId) {
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
      return new Promise((resolve) => pending.set(callId, resolve));
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

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function escapeJs(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function escapeForSelector(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
