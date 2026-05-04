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
  const toolbarId = 'insidebar-selection-toolbar';
  let toolbar = null;
  let selectedText = '';
  let hideTimer = null;

  if (PROVIDER_HOSTS.has(window.location.hostname) || window.top !== window) {
    return;
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
  }

  function hideToolbar() {
    if (toolbar) {
      toolbar.hidden = true;
    }
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

  async function handleActionClick(event) {
    const action = event.currentTarget.dataset.action;
    const text = selectedText || getSelectionInfo()?.text;
    if (!text) {
      hideToolbar();
      return;
    }

    hideToolbar();

    try {
      await chrome.runtime.sendMessage({
        action: 'selectionToolbarSend',
        payload: {
          prompt: buildPrompt(action, text.slice(0, MAX_SELECTION_LENGTH)),
          pageUrl: window.location.href
        }
      });
    } catch (error) {
      console.warn('[insidebar.ai] Failed to send selected text:', error);
    }
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
  document.addEventListener('scroll', hideToolbar, true);
  window.addEventListener('resize', hideToolbar);
})();
