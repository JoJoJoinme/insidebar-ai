// Lightweight selected-text toolbar for sending prompts to insidebar.ai.
(function() {
  'use strict';

  const PROVIDER_HOSTS = new Set([
    'chatgpt.com',
    'chat.openai.com',
    'claude.ai',
    'gemini.google.com',
    'grok.com',
    'chat.deepseek.com',
    'www.perplexity.ai',
    'perplexity.ai',
    'copilot.microsoft.com',
    'www.bing.com',
    'bing.com'
  ]);

  const ACTIONS = [
    { id: 'send', label: 'Send', title: 'Send selected text' },
    { id: 'explain', label: 'Explain', title: 'Explain selected text' },
    { id: 'translate', label: 'Translate', title: 'Translate selected text' },
    { id: 'summary', label: 'Summary', title: 'Summarize selected text' },
    { id: 'ask', label: 'Ask', title: 'Ask about selected text' }
  ];

  const MAX_SELECTION_LENGTH = 12000;
  const DEFAULT_OPEN_MODE = 'floating';
  const toolbarId = 'insidebar-selection-toolbar';
  const askPanelId = 'insidebar-selection-ask-panel';
  const floatingWindowId = 'insidebar-selection-floating-window';
  let toolbar = null;
  let askPanel = null;
  let floatingWindow = null;
  let floatingFrame = null;
  let floatingFrameReady = false;
  let floatingPreloadRequested = false;
  let floatingPreloadSent = false;
  let pendingFloatingPayload = null;
  let currentFloatingPayload = null;
  let selectedText = '';
  let askPanelText = '';
  let askPanelAnchorRect = null;
  let selectionToolbarOpenMode = DEFAULT_OPEN_MODE;
  let hideTimer = null;

  if (PROVIDER_HOSTS.has(window.location.hostname) || window.top !== window) {
    return;
  }

  loadSelectionToolbarOpenMode();

  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'sync' && changes.selectionToolbarOpenMode) {
        selectionToolbarOpenMode = normalizeOpenMode(changes.selectionToolbarOpenMode.newValue);
      }
    });
  }

  function createToolbar() {
    const element = document.createElement('div');
    element.id = toolbarId;
    element.hidden = true;

    for (const action of ACTIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.action = action.id;
      button.textContent = action.label;
      button.title = action.title;
      button.addEventListener('click', handleActionClick);
      element.appendChild(button);
    }

    element.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    document.documentElement.appendChild(element);
    return element;
  }

  function getToolbar() {
    if (!toolbar || !document.documentElement.contains(toolbar)) {
      toolbar = createToolbar();
    }
    return toolbar;
  }

  function createAskPanel() {
    const element = document.createElement('div');
    element.id = askPanelId;
    element.hidden = true;

    const textarea = document.createElement('textarea');
    textarea.rows = 3;
    textarea.placeholder = 'Ask about the selected text...';
    textarea.setAttribute('aria-label', 'Ask about selected text');
    textarea.addEventListener('keydown', handleAskKeydown);

    const quote = document.createElement('div');
    quote.className = 'insidebar-selection-ask-quote';

    const quoteLabel = document.createElement('div');
    quoteLabel.className = 'insidebar-selection-ask-quote-label';
    quoteLabel.textContent = 'Selected content';

    const quoteText = document.createElement('div');
    quoteText.className = 'insidebar-selection-ask-quote-text';

    quote.append(quoteLabel, quoteText);

    const footer = document.createElement('div');
    footer.className = 'insidebar-selection-ask-footer';

    const hint = document.createElement('span');
    hint.textContent = 'Ctrl/Cmd+Enter';

    const actions = document.createElement('div');
    actions.className = 'insidebar-selection-ask-actions';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.dataset.action = 'cancel';
    cancelButton.textContent = 'Cancel';
    cancelButton.addEventListener('click', hideAskPanel);

    const sendButton = document.createElement('button');
    sendButton.type = 'button';
    sendButton.dataset.action = 'send-question';
    sendButton.textContent = 'Send';
    sendButton.addEventListener('click', submitAskPanel);

    actions.append(cancelButton, sendButton);
    footer.append(hint, actions);
    element.append(quote, textarea, footer);

    element.addEventListener('mousedown', (event) => {
      event.stopPropagation();
    });

    document.documentElement.appendChild(element);
    return element;
  }

  function getAskPanel() {
    if (!askPanel || !document.documentElement.contains(askPanel)) {
      askPanel = createAskPanel();
    }
    return askPanel;
  }

  function createFloatingWindow() {
    const element = document.createElement('div');
    element.id = floatingWindowId;
    element.hidden = true;

    const header = document.createElement('div');
    header.className = 'insidebar-selection-floating-header';

    const title = document.createElement('div');
    title.className = 'insidebar-selection-floating-title';
    title.textContent = 'insidebar.ai Ask';

    const controls = document.createElement('div');
    controls.className = 'insidebar-selection-floating-controls';

    const sidePanelButton = document.createElement('button');
    sidePanelButton.type = 'button';
    sidePanelButton.className = 'insidebar-selection-floating-control insidebar-selection-floating-dock';
    sidePanelButton.textContent = 'Dock';
    sidePanelButton.title = 'Open in sidebar';
    sidePanelButton.setAttribute('aria-label', 'Open floating Ask in sidebar');
    sidePanelButton.addEventListener('click', openFloatingInSidePanel);

    const optionsButton = document.createElement('button');
    optionsButton.type = 'button';
    optionsButton.className = 'insidebar-selection-floating-control';
    optionsButton.textContent = '...';
    optionsButton.title = 'Open options';
    optionsButton.setAttribute('aria-label', 'Open insidebar.ai options');
    optionsButton.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'openOptionsPage' }).catch((error) => {
        console.warn('[insidebar.ai] Failed to open options:', error);
      });
    });

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'insidebar-selection-floating-close';
    closeButton.textContent = 'x';
    closeButton.title = 'Close';
    closeButton.setAttribute('aria-label', 'Close floating Ask window');
    closeButton.addEventListener('click', hideFloatingWindow);

    controls.append(sidePanelButton, optionsButton, closeButton);
    header.append(title, controls);

    const frame = document.createElement('iframe');
    frame.id = 'insidebar-selection-floating-frame';
    frame.title = 'insidebar.ai Ask';
    frame.allow = 'clipboard-read; clipboard-write';
    frame.src = chrome.runtime.getURL('floating/floating.html');
    frame.addEventListener('load', () => {
      floatingFrameReady = true;
      flushFloatingPreload();
      flushFloatingPayload();
    });

    header.addEventListener('mousedown', startFloatingDrag);
    element.append(header, frame);
    document.documentElement.appendChild(element);

    floatingFrame = frame;
    window.addEventListener('message', handleFloatingMessage);
    return element;
  }

  function getFloatingWindow() {
    if (!floatingWindow || !document.documentElement.contains(floatingWindow)) {
      floatingFrameReady = false;
      floatingPreloadRequested = false;
      floatingPreloadSent = false;
      floatingFrame = null;
      floatingWindow = createFloatingWindow();
    }
    return floatingWindow;
  }

  function getSelectionInfo() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }

    const text = selection.toString().trim().replace(/^-+|-+$/g, '');
    if (!text) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const rects = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0
    );
    const rect = rects[rects.length - 1] || range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      return null;
    }

    return { text, rect };
  }

  function loadSelectionToolbarOpenMode() {
    try {
      chrome.storage.sync.get({ selectionToolbarOpenMode: DEFAULT_OPEN_MODE }, (settings) => {
        if (chrome.runtime.lastError) {
          selectionToolbarOpenMode = DEFAULT_OPEN_MODE;
          return;
        }
        selectionToolbarOpenMode = normalizeOpenMode(settings.selectionToolbarOpenMode);
      });
    } catch (error) {
      selectionToolbarOpenMode = DEFAULT_OPEN_MODE;
    }
  }

  function normalizeOpenMode(value) {
    return value === 'sidePanel' ? 'sidePanel' : DEFAULT_OPEN_MODE;
  }

  function showToolbar() {
    window.clearTimeout(hideTimer);

    const info = getSelectionInfo();
    if (!info) {
      hideToolbar();
      return;
    }

    selectedText = info.text.slice(0, MAX_SELECTION_LENGTH);
    const element = getToolbar();
    element.hidden = false;

    const margin = 8;
    const toolbarRect = element.getBoundingClientRect();
    const topCandidate = info.rect.top - toolbarRect.height - margin;
    const top = topCandidate >= margin ? topCandidate : info.rect.bottom + margin;
    const left = Math.min(
      Math.max(info.rect.left, margin),
      window.innerWidth - toolbarRect.width - margin
    );

    element.style.top = `${Math.max(margin, top)}px`;
    element.style.left = `${left}px`;
    requestFloatingPreload();
  }

  function hideToolbar() {
    if (toolbar) {
      toolbar.hidden = true;
    }
  }

  function showAskPanel(anchorRect, text) {
    askPanelText = text.slice(0, MAX_SELECTION_LENGTH);
    askPanelAnchorRect = anchorRect;
    const element = getAskPanel();
    const textarea = element.querySelector('textarea');
    const quoteText = element.querySelector('.insidebar-selection-ask-quote-text');
    textarea.value = '';
    quoteText.textContent = truncateText(askPanelText, 420);
    quoteText.title = askPanelText;
    element.hidden = false;

    const margin = 8;
    const panelRect = element.getBoundingClientRect();
    const topCandidate = anchorRect.bottom + margin;
    const top = Math.min(
      Math.max(margin, topCandidate),
      window.innerHeight - panelRect.height - margin
    );
    const left = Math.min(
      Math.max(anchorRect.left, margin),
      window.innerWidth - panelRect.width - margin
    );

    element.style.top = `${top}px`;
    element.style.left = `${left}px`;
    textarea.focus();
  }

  function hideAskPanel() {
    askPanelText = '';
    askPanelAnchorRect = null;
    if (askPanel) {
      askPanel.hidden = true;
    }
  }

  function truncateText(text, maxLength) {
    if (!text || text.length <= maxLength) {
      return text || '';
    }
    return `${text.slice(0, maxLength - 3)}...`;
  }

  function scheduleHide() {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (!getSelectionInfo()) {
        hideToolbar();
      }
    }, 120);
  }

  function buildPrompt(action, text) {
    if (action === 'send') {
      return text;
    }

    const prompts = {
      explain:
        'Explain the following content clearly. Highlight the key points and reply in the most appropriate language:\n\n',
      translate:
        "Translate the following text into the user's preferred language. Preserve meaning, tone, and formatting. If it is already in that language, translate it into English:\n\n",
      summary:
        'Summarize the following content concisely. Focus on the key facts, conclusions, and any important caveats:\n\n',
      ask:
        'Analyze the following content and answer with a concise opinion or explanation:\n\n'
    };

    return `${prompts[action] || ''}'''\n${text}\n'''`;
  }

  function buildAskPrompt(question, text) {
    return `Answer the user's question about the selected content. Be concise and cite the relevant part when useful.\n\nQuestion:\n${question}\n\nSelected content:\n'''\n${text}\n'''`;
  }

  async function sendPrompt(prompt, options = {}) {
    await chrome.runtime.sendMessage({
      action: 'selectionToolbarSend',
      payload: {
        prompt,
        pageUrl: window.location.href,
        autoSubmit: options.autoSubmit === true
      }
    });
  }

  async function submitAskPanel() {
    const element = getAskPanel();
    const textarea = element.querySelector('textarea');
    const question = textarea.value.trim();
    const text = askPanelText;
    const anchorRect = askPanelAnchorRect || element.getBoundingClientRect();
    if (!question || !text) {
      return;
    }

    hideAskPanel();

    const payload = {
      action: 'ask',
      actionLabel: getActionLabel('ask'),
      question,
      selectedText: text,
      prompt: buildAskPrompt(question, text),
      pageUrl: window.location.href,
      autoSubmit: true
    };

    if (selectionToolbarOpenMode === 'sidePanel') {
      try {
        await sendPrompt(payload.prompt, { autoSubmit: true });
      } catch (error) {
        console.warn('[insidebar.ai] Failed to send selected text:', error);
      }
      return;
    }

    openFloatingConversation(payload, anchorRect);
  }

  function openFloatingConversation(payload, anchorRect) {
    const element = getFloatingWindow();
    const wasHidden = element.hidden;
    element.hidden = false;
    currentFloatingPayload = payload;

    if (wasHidden || !element.dataset.positioned) {
      positionFloatingWindow(element, anchorRect);
    }

    pendingFloatingPayload = {
      type: 'INSIDEBAR_FLOATING_PROMPT',
      payload
    };
    flushFloatingPayload();
  }

  function flushFloatingPayload() {
    if (!pendingFloatingPayload || !floatingFrameReady || !floatingFrame?.contentWindow) {
      return;
    }

    floatingFrame.contentWindow.postMessage(pendingFloatingPayload, '*');
    pendingFloatingPayload = null;
  }

  function requestFloatingPreload() {
    if (selectionToolbarOpenMode !== 'floating') {
      return;
    }

    preloadFloatingProvider();
  }

  function preloadFloatingProvider() {
    if (floatingPreloadSent || floatingPreloadRequested) {
      return;
    }

    floatingPreloadRequested = true;
    getFloatingWindow();
    flushFloatingPreload();
  }

  function flushFloatingPreload() {
    if (!floatingPreloadRequested || !floatingFrameReady || !floatingFrame?.contentWindow) {
      return;
    }

    floatingFrame.contentWindow.postMessage({ type: 'INSIDEBAR_FLOATING_PRELOAD' }, '*');
    floatingPreloadRequested = false;
    floatingPreloadSent = true;
  }

  function positionFloatingWindow(element, anchorRect) {
    const margin = 12;
    const rect = element.getBoundingClientRect();
    const width = rect.width || 640;
    const height = rect.height || 560;
    const topCandidate = anchorRect ? anchorRect.top : margin;
    const leftCandidate = anchorRect ? anchorRect.left : window.innerWidth - width - margin;
    const top = clamp(topCandidate, margin, window.innerHeight - height - margin);
    const left = clamp(leftCandidate, margin, window.innerWidth - width - margin);

    element.style.top = `${top}px`;
    element.style.left = `${left}px`;
    element.dataset.positioned = 'true';
  }

  function hideFloatingWindow() {
    if (floatingWindow) {
      floatingWindow.hidden = true;
    }
  }

  function showFloatingWindow(anchorRect = null) {
    const element = getFloatingWindow();
    const wasHidden = element.hidden;
    element.hidden = false;

    if (wasHidden || !element.dataset.positioned) {
      positionFloatingWindow(element, anchorRect);
    }

    preloadFloatingProvider();
  }

  async function openFloatingInSidePanel() {
    const payload = currentFloatingPayload;
    if (!payload?.prompt) {
      return;
    }

    hideFloatingWindow();

    try {
      await sendPrompt(payload.prompt, {
        autoSubmit: payload.autoSubmit === true
      });
    } catch (error) {
      console.warn('[insidebar.ai] Failed to open selected text in sidebar:', error);
    }
  }

  function startFloatingDrag(event) {
    if (event.button !== 0 || event.target.closest('button')) {
      return;
    }

    const element = getFloatingWindow();
    const rect = element.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startTop = rect.top;
    const startLeft = rect.left;

    event.preventDefault();
    element.classList.add('insidebar-selection-floating-dragging');

    const move = (moveEvent) => {
      const nextLeft = clamp(
        startLeft + moveEvent.clientX - startX,
        0,
        window.innerWidth - rect.width
      );
      const nextTop = clamp(
        startTop + moveEvent.clientY - startY,
        0,
        window.innerHeight - rect.height
      );

      element.style.left = `${nextLeft}px`;
      element.style.top = `${nextTop}px`;
    };

    const stop = () => {
      element.classList.remove('insidebar-selection-floating-dragging');
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', stop, true);
    };

    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', stop, true);
  }

  function handleFloatingMessage(event) {
    if (!floatingFrame || event.source !== floatingFrame.contentWindow) {
      return;
    }

    const data = event.data;
    if (!data || data.type !== 'INSIDEBAR_FLOATING_STATUS') {
      return;
    }

    const title = floatingWindow?.querySelector('.insidebar-selection-floating-title');
    if (title && data.title) {
      title.textContent = data.title;
    }
  }

  function clamp(value, min, max) {
    if (max < min) {
      return min;
    }
    return Math.min(Math.max(value, min), max);
  }

  function handleAskKeydown(event) {
    if (event.key === 'Escape') {
      hideAskPanel();
      return;
    }

    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submitAskPanel();
    }
  }

  async function handleActionClick(event) {
    const action = event.currentTarget.dataset.action;
    const info = getSelectionInfo();
    const text = (selectedText || info?.text || '').slice(0, MAX_SELECTION_LENGTH);
    if (!text) {
      hideToolbar();
      return;
    }

    if (action === 'ask') {
      const rect = info?.rect || event.currentTarget.getBoundingClientRect();
      hideToolbar();
      showAskPanel(rect, text);
      return;
    }

    hideToolbar();
    const prompt = buildPrompt(action, text);

    if (selectionToolbarOpenMode === 'sidePanel') {
      try {
        await sendPrompt(prompt);
      } catch (error) {
        console.warn('[insidebar.ai] Failed to send selected text:', error);
      }
      return;
    }

    openFloatingConversation({
      action,
      actionLabel: getActionLabel(action),
      selectedText: text,
      prompt,
      pageUrl: window.location.href,
      autoSubmit: false
    }, info?.rect || event.currentTarget.getBoundingClientRect());
  }

  function getActionLabel(action) {
    return ACTIONS.find((item) => item.id === action)?.label || 'Ask';
  }

  document.addEventListener('mouseup', () => {
    window.setTimeout(showToolbar, 0);
  });

  document.addEventListener('keyup', (event) => {
    if (event.key.startsWith('Arrow') || event.key === 'Shift') {
      window.setTimeout(showToolbar, 0);
    }
  });

  document.addEventListener('selectionchange', scheduleHide);
  document.addEventListener('scroll', () => {
    hideToolbar();
    hideAskPanel();
  }, true);
  window.addEventListener('resize', () => {
    hideToolbar();
    hideAskPanel();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action !== 'openSelectionFloating') {
      return false;
    }

    showFloatingWindow();
    sendResponse({ success: true });
    return false;
  });
})();
