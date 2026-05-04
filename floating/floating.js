import { getProviderByIdWithSettings } from '../modules/providers.js';

const DEFAULT_ENABLED_PROVIDERS = [
  'chatgpt',
  'claude',
  'gemini',
  'google',
  'grok',
  'deepseek',
  'copilot'
];
const FRAME_SANDBOX = 'allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox';
const MAX_PREVIEW_LENGTH = 900;

const reference = document.getElementById('reference');
const referenceQuestion = document.getElementById('reference-question');
const referenceText = document.getElementById('reference-text');
const providerShell = document.getElementById('provider-shell');
const status = document.getElementById('status');

let providerIframe = null;
let providerIframeId = null;
let providerIframeReady = false;
let providerIframeLoadPromise = null;

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'INSIDEBAR_FLOATING_PROMPT') {
    return;
  }

  handlePrompt(data.payload).catch((error) => {
    console.warn('[insidebar.ai] Floating Ask failed:', error);
    setStatus(error.message || 'Unable to open the floating Ask window.');
  });
});

notifyParent('insidebar.ai Ask');

async function handlePrompt(payload) {
  if (!payload?.prompt) {
    return;
  }

  setReference(payload.question, payload.selectedText);
  setStatus('Opening provider...');

  const providerId = await getDefaultProviderId();
  const provider = await getProviderByIdWithSettings(providerId);
  if (!provider) {
    throw new Error(`Provider ${providerId} not found.`);
  }

  notifyParent(`insidebar.ai Ask - ${provider.name}`);
  await loadProvider(provider);

  const settings = await chrome.storage.sync.get({
    sourceUrlPlacement: 'end',
    selectionToolbarAutoSubmit: false
  });
  const prompt = formatContentWithSource(
    payload.prompt,
    payload.pageUrl,
    settings.sourceUrlPlacement
  );

  injectPrompt(prompt, payload.autoSubmit === true || settings.selectionToolbarAutoSubmit === true);
}

async function getDefaultProviderId() {
  const settings = await chrome.storage.sync.get({
    lastSelectedProvider: 'chatgpt',
    defaultProvider: 'chatgpt',
    rememberLastProvider: true,
    enabledProviders: DEFAULT_ENABLED_PROVIDERS
  });

  const preferredProvider = settings.rememberLastProvider
    ? (settings.lastSelectedProvider || settings.defaultProvider)
    : settings.defaultProvider;

  if (settings.enabledProviders.includes(preferredProvider)) {
    return preferredProvider;
  }

  return settings.enabledProviders[0] || 'chatgpt';
}

function formatContentWithSource(text, pageUrl, placement) {
  if (!pageUrl || placement === 'none') {
    return text;
  }

  if (placement === 'beginning') {
    return `Source: ${pageUrl}\n\n${text}`;
  }

  return `${text}\n\nSource: ${pageUrl}`;
}

async function loadProvider(provider) {
  if (providerIframe && providerIframeId === provider.id) {
    await waitForProviderFrame();
    return;
  }

  if (providerIframe) {
    providerIframe.remove();
  }

  providerIframeReady = false;
  providerIframeId = provider.id;
  providerIframe = document.createElement('iframe');
  providerIframe.src = provider.url;
  providerIframe.title = provider.name;
  providerIframe.sandbox = FRAME_SANDBOX;
  providerIframe.allow = 'clipboard-read; clipboard-write';
  providerIframe.loading = 'eager';

  providerIframeLoadPromise = new Promise((resolve) => {
    const finish = () => {
      providerIframeReady = true;
      status.hidden = true;
      resolve();
    };

    providerIframe.addEventListener('load', finish, { once: true });
    providerIframe.addEventListener('error', () => {
      setStatus(`Failed to load ${provider.name}.`);
      resolve();
    }, { once: true });
  });

  providerShell.appendChild(providerIframe);
  await providerIframeLoadPromise;
}

async function waitForProviderFrame() {
  if (providerIframeReady) {
    return;
  }

  if (providerIframeLoadPromise) {
    await providerIframeLoadPromise;
  }
}

function injectPrompt(prompt, autoSubmit) {
  if (!providerIframe?.contentWindow) {
    setStatus('Provider frame is not ready.');
    return;
  }

  providerIframe.contentWindow.postMessage({
    type: 'INJECT_TEXT',
    text: prompt,
    autoSubmit
  }, '*');
}

function setReference(question, selectedText) {
  const cleanQuestion = typeof question === 'string' ? question.trim() : '';
  const cleanText = typeof selectedText === 'string' ? selectedText.trim() : '';

  if (!cleanQuestion && !cleanText) {
    reference.hidden = true;
    return;
  }

  referenceQuestion.textContent = cleanQuestion ? `Question: ${cleanQuestion}` : '';
  referenceText.textContent = truncateText(cleanText, MAX_PREVIEW_LENGTH);
  referenceText.title = cleanText;
  reference.hidden = false;
}

function truncateText(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return text || '';
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function setStatus(message) {
  status.textContent = message;
  status.hidden = false;
}

function notifyParent(title) {
  window.parent.postMessage({
    type: 'INSIDEBAR_FLOATING_STATUS',
    title
  }, '*');
}
