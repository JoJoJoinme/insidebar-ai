import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mcpVersion = '1.0.1';
const mcpDir = path.join(repoRoot, '.tmp', `chrome-devtools-mcp-${mcpVersion}`);
const mcpTgz = path.join(repoRoot, '.tmp', `chrome-devtools-mcp-${mcpVersion}.tgz`);
const mcpTarball = `https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-${mcpVersion}.tgz`;
const defaultProfile = path.join(repoRoot, '.chrome-profile');

const chromePath = process.env.CHROME_PATH || findChrome();
const userDataDir = path.resolve(process.env.MCP_USER_DATA_DIR || defaultProfile);
const providerUrl = process.env.MCP_PROVIDER_URL || 'https://chatgpt.com/';

if (!chromePath) {
  throw new Error('Chrome executable not found. Set CHROME_PATH to continue.');
}

await ensureMcpPackage();

const client = await startMcp();
try {
  await client.initialize();

  const installText = await client.callText('install_extension', { path: repoRoot });
  const extensionsText = await client.callText('list_extensions');
  const extensionId = matchFirst(installText, /Id:\s*([a-p]{32})/i) || matchFirst(extensionsText, /id=([a-p]{32})/i);

  if (!extensionId) {
    throw new Error(`Unable to resolve installed extension id.\n${installText}\n${extensionsText}`);
  }

  const pagesBefore = await client.callText('list_pages');
  const serviceWorkerId = matchFirst(pagesBefore, /^(sw-\d+): chrome-extension:\/\/[^\s]+\/background\/service-worker\.js/m);
  if (serviceWorkerId) {
    await client.callJson('evaluate_script', {
      serviceWorkerId,
      function: `async () => {
        await chrome.storage.sync.set({
          selectionToolbarOpenMode: 'floating',
          lastSelectedProvider: 'chatgpt',
          rememberLastProvider: true,
          enabledProviders: ['chatgpt', 'claude', 'gemini', 'google', 'grok', 'deepseek']
        });
        return true;
      }`
    });
  }

  await client.callText('new_page', { url: providerUrl, timeout: 15000 });
  await client.callText('wait_for', { text: 'ChatGPT', timeout: 10000 }).catch(() => '');
  const providerState = await client.callJson('evaluate_script', {
    function: `() => {
      const text = document.body?.innerText || '';
      const editor = !!document.querySelector('#prompt-textarea, textarea, [contenteditable="true"], [data-testid="composer"], [data-testid="composer-textarea"]');
      const authWall = /log in|sign up|continue with google|continue with apple/i.test(text);
      const challenge = /just a moment|checking your browser|verify you are human/i.test(document.title + '\\n' + text);
      return {
        url: location.href,
        title: document.title,
        editor,
        authWall,
        challenge,
        textSample: text.replace(/\\s+/g, ' ').slice(0, 180)
      };
    }`
  });
  providerState.classification = classifyProviderState(providerState);

  await client.callText('new_page', { url: 'https://example.com/', timeout: 15000 });
  const toolbarState = await client.callJson('evaluate_script', {
    function: `async () => {
      const target = document.querySelector('p') || document.body;
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const rect = range.getBoundingClientRect();
      document.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        clientX: Math.max(10, rect.left + 20),
        clientY: Math.max(10, rect.top + 10)
      }));
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const toolbar = document.querySelector('[data-testid="selection-toolbar"]');
      return {
        selectedLength: selection.toString().trim().length,
        toolbarInjected: !!toolbar,
        toolbarHidden: toolbar ? toolbar.hidden : null,
        openMode: toolbar?.dataset.openMode || null,
        buttons: toolbar ? Array.from(toolbar.querySelectorAll('button')).map((button) => button.dataset.action) : []
      };
    }`
  });

  assert(toolbarState.toolbarInjected && toolbarState.toolbarHidden === false, 'Selection toolbar did not appear.');

  const floatingState = await client.callJson('evaluate_script', {
    function: `async () => {
      document.querySelector('[data-testid="selection-toolbar-send"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 4000));
      const win = document.querySelector('[data-testid="floating-window"]');
      const frame = document.querySelector('[data-testid="floating-frame"]');
      return {
        floatingExists: !!win,
        floatingHidden: win ? win.hidden : null,
        title: win?.querySelector('.insidebar-selection-floating-title')?.textContent || null,
        activeProvider: win?.dataset.activeProvider || null,
        frameSrc: frame?.src || null,
        floatingFrameInspectableFromHost: !!frame?.contentDocument
      };
    }`
  });

  assert(floatingState.floatingExists && floatingState.floatingHidden === false, 'Floating window did not open.');

  const secondToolbarSendState = await client.callJson('evaluate_script', {
    function: `async () => {
      const target = document.querySelector('p') || document.body;
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const rect = range.getBoundingClientRect();
      document.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        clientX: Math.max(10, rect.left + 20),
        clientY: Math.max(10, rect.top + 10)
      }));
      await new Promise((resolve) => setTimeout(resolve, 1000));
      document.querySelector('[data-testid="selection-toolbar-summary"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const win = document.querySelector('[data-testid="floating-window"]');
      const frame = document.querySelector('[data-testid="floating-frame"]');
      return {
        floatingExists: !!win,
        floatingHidden: win ? win.hidden : null,
        activeProvider: win?.dataset.activeProvider || null,
        title: win?.querySelector('.insidebar-selection-floating-title')?.textContent || null,
        frameSrc: frame?.src || null
      };
    }`
  });

  const pagesAfter = await client.callText('list_pages');

  const result = {
    chromePath,
    userDataDir,
    extensionId,
    extensionsText,
    providerState,
    toolbarState,
    floatingState,
    secondToolbarSendState,
    pagesAfter
  };

  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close();
}

function findChrome() {
  const candidates = [];
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    const localAppData = process.env.LOCALAPPDATA;
    if (programFiles) candidates.push(path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (programFilesX86) candidates.push(path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (localAppData) candidates.push(path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

async function ensureMcpPackage() {
  fs.mkdirSync(path.dirname(mcpTgz), { recursive: true });
  if (!fs.existsSync(path.join(mcpDir, 'build', 'src', 'bin', 'chrome-devtools-mcp.js'))) {
    if (!fs.existsSync(mcpTgz)) {
      const response = await fetch(mcpTarball);
      if (!response.ok) {
        throw new Error(`Failed to download chrome-devtools-mcp: ${response.status} ${response.statusText}`);
      }
      fs.writeFileSync(mcpTgz, Buffer.from(await response.arrayBuffer()));
    }
    fs.rmSync(mcpDir, { recursive: true, force: true });
    fs.mkdirSync(mcpDir, { recursive: true });
    const tar = spawnSync('tar', ['-xzf', mcpTgz, '-C', mcpDir, '--strip-components', '1'], { stdio: 'inherit' });
    if (tar.status !== 0) {
      throw new Error('Failed to extract chrome-devtools-mcp tarball.');
    }
  }
}

async function startMcp() {
  fs.mkdirSync(userDataDir, { recursive: true });
  const serverPath = path.join(mcpDir, 'build', 'src', 'bin', 'chrome-devtools-mcp.js');
  const child = spawn(process.execPath, [
    serverPath,
    `--executable-path=${chromePath}`,
    `--user-data-dir=${userDataDir}`,
    '--no-usage-statistics',
    '--category-extensions',
    '--experimental-include-all-pages',
    '--ignore-default-chrome-arg=--disable-extensions',
    '--chrome-arg=--enable-unsafe-extension-debugging',
    '--chrome-arg=--disable-features=DisableLoadExtensionCommandLineSwitch'
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1'
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (!text.includes('exposes content') && !text.includes('Performance tools')) {
      process.stderr.write(text);
    }
  });

  let buffer = '';
  let nextId = 1;
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf(os.EOL)) >= 0 || (index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          entry.reject(new Error(JSON.stringify(message.error)));
        } else {
          entry.resolve(message.result);
        }
      }
    }
  });

  function send(method, params) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  return {
    async initialize() {
      await send('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'insidebar-real-debug', version: '0.1.0' }
      });
      notify('notifications/initialized', {});
    },
    async call(name, args = {}) {
      return send('tools/call', { name, arguments: args });
    },
    async callText(name, args = {}) {
      const result = await this.call(name, args);
      return toText(result);
    },
    async callJson(name, args = {}) {
      const result = await this.call(name, args);
      return parseToolJson(result);
    },
    async close() {
      child.kill();
    }
  };
}

function toText(result) {
  return (result?.content || []).map((item) => item.text || '').join('\n');
}

function parseToolJson(result) {
  const raw = toText(result).trim();
  const fenced = raw.match(/```json\n([\s\S]*?)\n```/) || raw.match(/```\n([\s\S]*?)\n```/);
  const body = fenced ? fenced[1] : raw;
  return JSON.parse(body);
}

function matchFirst(text, pattern) {
  return text.match(pattern)?.[1] || null;
}

function classifyProviderState(state) {
  if (state.editor) return 'editor_ready';
  if (state.authWall) return 'auth_required';
  if (state.challenge) return 'challenge_or_loading';
  return 'editor_not_detected';
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
