import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const defaultChromeBin = '/root/.cache/puppeteer/chrome/linux-144.0.7559.96/chrome-linux64/chrome';
const chromeBin = process.env.CHROME_BIN || defaultChromeBin;
const port = Number(process.env.CFT_PORT || 9394);
const targetUrl = process.env.TEST_URL || 'https://hai.stanford.edu/ai-index/2026-ai-index-report';
const unpackedDir = process.env.EXT_DIR || path.join(repoRoot, 'dist/insidebar-ai-chrome-unpacked');
const profileDir = process.env.CFT_PROFILE || path.join(os.tmpdir(), `insidebar-regression-${Date.now()}`);
const screenshotDir = path.join(repoRoot, 'dist/visual-checks');

let chromeProcess = null;

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (process.env.KEEP_CHROME !== '1') {
    chromeProcess?.kill('SIGTERM');
  }
});

async function main() {
  if (!fs.existsSync(chromeBin)) {
    throw new Error(`Chrome for Testing binary not found: ${chromeBin}`);
  }

  prepareUnpackedExtension();
  fs.mkdirSync(screenshotDir, { recursive: true });
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });

  chromeProcess = spawn(chromeBin, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${unpackedDir}`,
    `--load-extension=${unpackedDir}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    '--window-size=1365,960',
    targetUrl
  ], { stdio: 'ignore', detached: false });

  await waitForDebugEndpoint();
  const serviceWorker = await waitForTarget((target) =>
    target.type === 'service_worker' && target.url.includes('/background/service-worker.js')
  );

  await evaluate(serviceWorker, `chrome.storage.sync.set({
    selectionToolbarOpenMode: 'floating',
    lastSelectedProvider: 'chatgpt',
    rememberLastProvider: true,
    enabledProviders: ['chatgpt', 'claude', 'gemini', 'google', 'grok', 'deepseek']
  })`);

  const page = await waitForTarget((target) => target.type === 'page' && target.url === targetUrl);
  await bringToFront(page);
  await navigate(page, targetUrl);
  const openState = await openFloatingFromSelection(page);
  assert(openState.toolbarFound, 'selection toolbar should be created');
  assert(openState.sendFound, 'selection toolbar Send button should be found');

  const outerState = await evaluate(page, `(() => {
    const win = document.querySelector('#insidebar-selection-floating-window');
    const buttons = Array.from(document.querySelectorAll(
      '#insidebar-selection-floating-window .insidebar-selection-floating-controls button'
    )).map((button) => button.title || button.textContent.trim());
    return {
      visible: !!win && !win.hidden,
      buttons,
      title: document.querySelector('#insidebar-selection-floating-window .insidebar-selection-floating-title')?.textContent || ''
    };
  })()`);

  assert(outerState.visible, `floating window should be visible after ${JSON.stringify(openState)}`);
  assertIncludes(outerState.buttons, 'Open chat history');
  assertIncludes(outerState.buttons, 'Open prompt library');
  assertIncludes(outerState.buttons, 'Open in sidebar');

  const floating = await waitForTarget((target) =>
    target.type === 'iframe' && target.url.includes('/floating/floating.html')
  );
  const floatingLayout = await evaluate(floating, `(() => {
    const shell = document.querySelector('#provider-shell');
    const tabs = document.querySelector('#floating-provider-tabs');
    const iframe = document.querySelector('#provider-shell iframe');
    return {
      innerHeight,
      shell: rect(shell),
      tabs: rect(tabs),
      iframe: rect(iframe),
      tabsText: tabs.textContent.trim(),
      providerTitles: Array.from(tabs.querySelectorAll('button')).map((button) => button.title),
      activeProvider: tabs.querySelector('button.active')?.dataset.providerId || null
    };
    function rect(element) {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
    }
  })()`);

  assert(floatingLayout.tabs.height > 0, 'provider tabs should be visible');
  assert(floatingLayout.tabs.bottom <= floatingLayout.innerHeight + 1, 'provider tabs must stay inside floating viewport');
  assert(floatingLayout.shell.bottom <= floatingLayout.tabs.top + 1, 'provider shell must not overlap provider tabs');
  assert(floatingLayout.tabsText === '', 'provider tabs should be icon-only');
  assertIncludes(floatingLayout.providerTitles, 'ChatGPT');
  assert(floatingLayout.activeProvider === 'ChatGPT' || floatingLayout.activeProvider === 'chatgpt',
    `expected ChatGPT active provider, got ${floatingLayout.activeProvider}`);

  const chatgptFrame = await waitForTarget((target) => target.type === 'iframe' && target.url.startsWith('https://chatgpt.com/'));
  const embeddedHeader = await waitForEvaluation(chatgptFrame, `(() => {
    const header = document.querySelector('header');
    return {
      hasLayoutStyle: !!document.getElementById('insidebar-embedded-provider-layout'),
      headerDisplay: header ? getComputedStyle(header).display : null
    };
  })()`, (value) => value.hasLayoutStyle && value.headerDisplay === 'none', 8000);
  assert(embeddedHeader.hasLayoutStyle, 'embedded ChatGPT layout style should be injected');
  assert(embeddedHeader.headerDisplay === 'none', `embedded ChatGPT header should be hidden, got ${embeddedHeader.headerDisplay}`);

  const switchResult = await evaluate(floating, `(async () => {
    document.querySelector('#floating-provider-tabs button[data-provider-id="claude"]').click();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const storage = await chrome.storage.sync.get({ lastSelectedProvider: 'chatgpt' });
    return {
      activeProvider: document.querySelector('#floating-provider-tabs button.active')?.dataset.providerId || null,
      storageProvider: storage.lastSelectedProvider
    };
  })()`);
  assert(switchResult.activeProvider === 'claude', `expected floating provider claude, got ${switchResult.activeProvider}`);
  assert(switchResult.storageProvider === 'claude', `expected storage provider claude, got ${switchResult.storageProvider}`);

  await clickOuterButton(page, 'Open in sidebar');
  await delay(1800);

  const storageAfterDock = await evaluate(serviceWorker, `chrome.storage.sync.get({ lastSelectedProvider: 'chatgpt' })`);
  assert(storageAfterDock.lastSelectedProvider === 'claude',
    `expected docked provider claude, got ${storageAfterDock.lastSelectedProvider}`);

  const sidebar = await waitForTarget((target) =>
    target.type === 'page' && target.url.includes('/sidebar/sidebar.html')
  );
  const sidebarState = await waitForEvaluation(sidebar, `(() => ({
    activeProvider: document.querySelector('#provider-tabs button.active')?.dataset.providerId || null,
    providerVisible: getComputedStyle(document.querySelector('#provider-container')).display,
    bottomTitles: Array.from(document.querySelectorAll('#provider-tabs button')).map((button) => button.title)
  }))()`, (value) => value.activeProvider === 'claude' && value.providerVisible === 'flex', 10000);
  assert(sidebarState.activeProvider === 'claude', `expected sidebar provider claude, got ${sidebarState.activeProvider}`);
  assert(sidebarState.providerVisible === 'flex', `expected provider view visible, got ${sidebarState.providerVisible}`);
  assert(!sidebarState.bottomTitles.includes('Open chat history'), 'sidebar provider tabs should not contain utility tools');

  await captureScreenshot(page, path.join(screenshotDir, 'selection-floating-regression.png'));
  console.log('selection floating regression passed');
}

function prepareUnpackedExtension() {
  fs.rmSync(unpackedDir, { recursive: true, force: true });
  fs.mkdirSync(unpackedDir, { recursive: true });
  const excluded = new Set(['.git', 'dist', 'node_modules', 'tests']);
  for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    if (excluded.has(entry.name)) {
      continue;
    }
    fs.cpSync(path.join(repoRoot, entry.name), path.join(unpackedDir, entry.name), {
      recursive: true
    });
  }
}

async function openFloatingFromSelection(page) {
  return evaluate(page, `(async () => {
    await new Promise((resolve) => document.readyState === 'complete'
      ? resolve()
      : window.addEventListener('load', resolve, { once: true }));
    const source = Array.from(document.querySelectorAll('p, h1, h2'))
      .find((element) => /AI|Index|technology|society/i.test(element.textContent || ''));
    if (!source) throw new Error('No selectable text found');
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
    const toolbar = document.querySelector('#insidebar-selection-toolbar');
    const send = document.querySelector('#insidebar-selection-toolbar button[data-action="send"]');
    if (send) {
      send.click();
    }
    for (let index = 0; index < 30; index += 1) {
      const floating = document.querySelector('#insidebar-selection-floating-window');
      if (floating && !floating.hidden) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const floating = document.querySelector('#insidebar-selection-floating-window');
    return {
      toolbarFound: !!toolbar,
      toolbarHidden: toolbar ? toolbar.hidden : null,
      sendFound: !!send,
      selectionLength: selection.toString().trim().length,
      openMode: window.__insidebarSelectionToolbarOpenMode || null,
      floatingFound: !!floating,
      floatingHidden: floating ? floating.hidden : null
    };
  })()`);
}

async function clickOuterButton(page, title) {
  const point = await evaluate(page, `(() => {
    const button = Array.from(document.querySelectorAll(
      '#insidebar-selection-floating-window .insidebar-selection-floating-controls button'
    )).find((candidate) => candidate.title === ${JSON.stringify(title)});
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert(point, `button not found: ${title}`);
  const client = await connect(page);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  client.close();
}

async function waitForDebugEndpoint() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // keep waiting
    }
    await delay(250);
  }
  throw new Error(`Chrome debug endpoint did not start on port ${port}`);
}

async function waitForTarget(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const targets = await getTargets();
    const target = targets.find(predicate);
    if (target) return target;
    await delay(250);
  }
  throw new Error('Timed out waiting for CDP target');
}

async function getTargets() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

async function bringToFront(target) {
  const client = await connect(target);
  await client.send('Page.bringToFront');
  client.close();
}

async function navigate(target, url) {
  const client = await connect(target);
  await client.send('Page.enable');
  await client.send('Page.navigate', { url });
  client.close();
  await delay(2000);
}

async function evaluate(target, expression) {
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

async function waitForEvaluation(target, expression, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let lastValue = null;
  while (Date.now() < deadline) {
    lastValue = await evaluate(target, expression);
    if (predicate(lastValue)) {
      return lastValue;
    }
    await delay(250);
  }
  return lastValue;
}

async function captureScreenshot(target, filePath) {
  const client = await connect(target);
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  client.close();
  fs.writeFileSync(filePath, Buffer.from(screenshot.result.data, 'base64'));
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

function assert(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function assertIncludes(values, expected) {
  assert(values.includes(expected), `expected ${JSON.stringify(values)} to include ${expected}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
