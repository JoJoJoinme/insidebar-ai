import { PROVIDERS, getProviderByIdWithSettings } from '../modules/providers.js';

const DEFAULT_ENABLED_PROVIDERS = [
  'chatgpt',
  'claude',
  'gemini',
  'google',
  'grok',
  'deepseek'
];
const FRAME_SANDBOX = 'allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox';
const MAX_PREVIEW_LENGTH = 900;

const reference = document.getElementById('reference');
const referenceQuestion = document.getElementById('reference-question');
const referenceText = document.getElementById('reference-text');
const providerShell = document.getElementById('provider-shell');
const providerTabs = document.getElementById('floating-provider-tabs');
const status = document.getElementById('status');

let providerIframe = null;
let providerIframeId = null;
let providerIframeReady = false;
let providerIframeLoadPromise = null;

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) {
    return;
  }

  if (data.type === 'INSIDEBAR_FLOATING_PRELOAD') {
    handlePreload().catch((error) => {
      console.warn('[insidebar.ai] Floating provider preload failed:', error);
    });
    return;
  }

  if (data.type === 'INSIDEBAR_FLOATING_PROMPT') {
    handlePrompt(data.payload).catch((error) => {
      console.warn('[insidebar.ai] Floating Ask failed:', error);
      setStatus(error.message || 'Unable to open the floating Ask window.');
    });
  }
});

notifyParent('insidebar.ai Ask');
renderProviderTabs().catch((error) => {
  console.warn('[insidebar.ai] Failed to render floating provider tabs:', error);
});

async function handlePreload() {
  if (providerIframe || providerIframeLoadPromise) {
    return;
  }

  const providerId = await getDefaultProviderId();
  const provider = await getProviderByIdWithSettings(providerId);
  if (!provider) {
    return;
  }

  notifyParent(`insidebar.ai Ask - ${provider.name}`, provider.id);
  setStatus('Opening provider...');
  await loadProvider(provider);
}

async function handlePrompt(payload) {
  if (!payload?.prompt) {
    return;
  }

  const providerId = await getDefaultProviderId();
  const provider = await getProviderByIdWithSettings(providerId);
  if (!provider) {
    throw new Error(`Provider ${providerId} not found.`);
  }

  setReference(payload);
  if (!providerIframe || providerIframeId !== provider.id) {
    setStatus('Opening provider...');
  }
  notifyParent(`insidebar.ai Ask - ${provider.name}`, provider.id);
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

  const enabledProviders = settings.enabledProviders.filter(providerId =>
    DEFAULT_ENABLED_PROVIDERS.includes(providerId)
  );

  if (enabledProviders.includes(preferredProvider)) {
    return preferredProvider;
  }

  return enabledProviders[0] || 'chatgpt';
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
    await renderProviderTabs(provider.id);
    await waitForProviderFrame();
    return;
  }

  if (providerIframe) {
    providerIframe.remove();
  }

  providerIframeReady = false;
  providerIframeId = provider.id;
  document.body.dataset.activeProvider = provider.id;
  providerShell.dataset.activeProvider = provider.id;
  await renderProviderTabs(provider.id);
  providerIframe = document.createElement('iframe');
  providerIframe.src = provider.url;
  providerIframe.title = provider.name;
  providerIframe.dataset.testid = 'floating-provider-frame';
  providerIframe.dataset.providerId = provider.id;
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
  status.hidden = true;
  await providerIframeLoadPromise;
}

async function renderProviderTabs(activeProviderId = providerIframeId) {
  const enabledProviders = await getEnabledProviders();
  providerTabs.innerHTML = '';
  providerTabs.dataset.activeProvider = activeProviderId || '';

  for (const provider of enabledProviders) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.providerId = provider.id;
    button.dataset.testid = `floating-provider-tab-${provider.id}`;
    button.title = provider.name;
    button.setAttribute('aria-label', provider.name);
    if (provider.id === activeProviderId) {
      button.classList.add('active');
    }

    const icon = document.createElement('img');
    icon.src = provider.icon;
    icon.alt = provider.name;

    button.appendChild(icon);
    button.addEventListener('click', () => {
      switchProviderFromTab(provider.id).catch((error) => {
        console.warn('[insidebar.ai] Failed to switch floating provider:', error);
        setStatus(error.message || `Failed to load ${provider.name}.`);
      });
    });
    providerTabs.appendChild(button);
  }
}

async function getEnabledProviders() {
  const settings = await chrome.storage.sync.get({
    enabledProviders: DEFAULT_ENABLED_PROVIDERS
  });
  const enabledIds = Array.isArray(settings.enabledProviders)
    ? settings.enabledProviders
    : DEFAULT_ENABLED_PROVIDERS;
  return PROVIDERS.filter((provider) => enabledIds.includes(provider.id));
}

async function switchProviderFromTab(providerId) {
  const provider = await getProviderByIdWithSettings(providerId);
  if (!provider) {
    throw new Error(`Provider ${providerId} not found.`);
  }

  await chrome.storage.sync.set({ lastSelectedProvider: providerId });
  notifyParent(`insidebar.ai Ask - ${provider.name}`, provider.id);

  if (!providerIframe || providerIframeId !== provider.id) {
    setStatus(`Opening ${provider.name}...`);
  }

  await loadProvider(provider);
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

function setReference(payload) {
  const cleanQuestion = typeof payload.question === 'string' ? payload.question.trim() : '';
  const cleanAction = typeof payload.actionLabel === 'string' ? payload.actionLabel.trim() : '';
  const cleanText = typeof payload.selectedText === 'string' ? payload.selectedText.trim() : '';

  if (!cleanQuestion && !cleanAction && !cleanText) {
    reference.hidden = true;
    return;
  }

  referenceQuestion.textContent = cleanQuestion
    ? `Question: ${cleanQuestion}`
    : (cleanAction ? `Action: ${cleanAction}` : '');
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

function notifyParent(title, providerId = providerIframeId) {
  window.parent.postMessage({
    type: 'INSIDEBAR_FLOATING_STATUS',
    title,
    providerId
  }, '*');
}
