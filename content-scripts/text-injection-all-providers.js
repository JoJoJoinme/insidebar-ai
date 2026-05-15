// Text injection handler for all AI providers
// Self-contained script without module imports (for iframe compatibility)

(function() {
  'use strict';

  // Provider-specific selectors
  const PROVIDER_SELECTORS = {
    chatgpt: ['#prompt-textarea'],
    claude: [
      '.ProseMirror[role="textbox"]',
      '.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"].ProseMirror',
      'div[contenteditable="true"]'
    ],
    gemini: ['.ql-editor'],
    grok: ['textarea', '.tiptap', '.ProseMirror'],
    deepseek: ['textarea.ds-scroll-area'],
    google: ['textarea.ITIRGe', 'textarea[aria-label="Ask anything"]', 'textarea[maxlength="8192"]'],
    // Copilot uses textarea with id="userInput" or data-testid="composer-input"
    copilot: ['textarea#userInput', 'textarea[data-testid="composer-input"]', 'textarea[placeholder*="Message Copilot"]']
  };

  const PROVIDER_SEND_BUTTON_SELECTORS = {
    chatgpt: [
      'button[data-testid="send-button"]',
      'button[data-testid="composer-send-button"]',
      '#composer-submit-button',
      'button[aria-label*="Send"]'
    ],
    claude: [
      'button[aria-label*="Send"]',
      'button[data-testid="send-button"]',
      'button[type="submit"]'
    ],
    gemini: [
      'button[aria-label*="Send"]',
      'button[aria-label*="Submit"]',
      'button.send-button'
    ],
    grok: [
      'button[aria-label*="Send"]',
      'button[data-testid="send-button"]',
      'button[type="submit"]'
    ],
    deepseek: [
      'button[aria-label*="Send"]',
      'button[type="submit"]'
    ],
    google: [
      'button[aria-label*="Send"]',
      'button[aria-label*="Submit"]',
      'button[type="submit"]'
    ],
    copilot: [
      'button[data-testid="submit-button"]',
      'button[data-testid="send-button"]',
      'button[aria-label*="Submit"]',
      'button[aria-label*="Send"]'
    ]
  };

  // Detect which provider we're on based on hostname
  function detectProvider() {
    const hostname = window.location.hostname;
    if (hostname.includes('chatgpt.com') || hostname.includes('openai.com')) {
      return 'chatgpt';
    } else if (hostname.includes('claude.ai')) {
      return 'claude';
    } else if (hostname.includes('gemini.google.com')) {
      return 'gemini';
    } else if (hostname.includes('grok.com')) {
      return 'grok';
    } else if (hostname.includes('deepseek.com')) {
      return 'deepseek';
    } else if (hostname.includes('google.com') && window.location.search.includes('udm=50')) {
      return 'google';
    } else if (hostname.includes('copilot.microsoft.com') || hostname.includes('bing.com/chat')) {
      return 'copilot';
    }
    return null;
  }

  function applyEmbeddedProviderLayout(provider) {
    if (window.top === window || provider !== 'chatgpt') {
      return;
    }

    if (document.getElementById('insidebar-embedded-provider-layout')) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'insidebar-embedded-provider-layout';
    style.textContent = `
      header {
        display: none !important;
      }

      html,
      body {
        overscroll-behavior: contain !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  // Find text input element by selector
  function findTextInputElement(selector) {
    if (!selector || typeof selector !== 'string') {
      return null;
    }

    try {
      return document.querySelector(selector);
    } catch (error) {
      console.error('Error finding element:', error);
      return null;
    }
  }

  // Inject text into an element (textarea or contenteditable)
  function injectTextIntoElement(element, text) {
    if (!element || !text || typeof text !== 'string' || text.trim() === '') {
      return false;
    }

    try {
      const isTextarea = element.tagName === 'TEXTAREA' || element.tagName === 'INPUT';
      const isContentEditable = element.isContentEditable || element.getAttribute('contenteditable') === 'true';

      if (!isTextarea && !isContentEditable) {
        console.warn('Element is not a textarea or contenteditable:', element);
        return false;
      }

      if (isTextarea) {
        // For textarea/input elements
        const currentValue = element.value || '';
        const newValue = currentValue + text;

        // For React - use native setter to bypass React's control
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeInputValueSetter.call(element, newValue);

        // Trigger multiple events to notify React/Vue/etc
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));

        // Move cursor to end (without focusing to avoid cross-origin error)
        element.selectionStart = element.selectionEnd = element.value.length;
      } else {
        // For contenteditable elements
        const currentText = element.textContent || '';
        element.textContent = currentText + text;

        // Trigger input event
        element.dispatchEvent(new Event('input', { bubbles: true }));

        // Move cursor to end for contenteditable (without focusing)
        try {
          const range = document.createRange();
          const selection = window.getSelection();
          range.selectNodeContents(element);
          range.collapse(false); // Collapse to end
          selection.removeAllRanges();
          selection.addRange(range);
        } catch (e) {
          // Ignore selection errors in cross-origin context
        }
      }

      return true;
    } catch (error) {
      console.error('Error injecting text:', error);
      return false;
    }
  }

  function isClickableButton(button) {
    if (!button) {
      return false;
    }

    const style = window.getComputedStyle(button);
    return (
      !button.disabled &&
      button.getAttribute('aria-disabled') !== 'true' &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      button.offsetParent !== null
    );
  }

  function findSendButton(provider) {
    const selectors = PROVIDER_SEND_BUTTON_SELECTORS[provider] || [];

    for (const selector of selectors) {
      try {
        const buttons = Array.from(document.querySelectorAll(selector));
        const button = buttons.find(isClickableButton);
        if (button) {
          return button;
        }
      } catch (error) {
        console.error('Error finding send button:', error);
      }
    }

    return Array.from(document.querySelectorAll('button')).find((button) => {
      const label = [
        button.getAttribute('aria-label'),
        button.getAttribute('title'),
        button.textContent
      ].filter(Boolean).join(' ');

      return isClickableButton(button) && /\b(send|submit)\b/i.test(label);
    }) || null;
  }

  function autoSubmitPrompt(provider) {
    let attempts = 0;
    const maxAttempts = 20;

    const tryClick = () => {
      attempts += 1;
      const button = findSendButton(provider);

      if (button) {
        button.click();
        return;
      }

      if (attempts < maxAttempts) {
        setTimeout(tryClick, 150);
      } else {
        console.warn(`[Text Injection] Send button not found for ${provider}`);
      }
    };

    setTimeout(tryClick, 250);
  }

  const handledInjectRequestIds = [];
  const MAX_HANDLED_INJECT_REQUEST_IDS = 100;

  function hasHandledInjectRequest(requestId) {
    return requestId && handledInjectRequestIds.includes(requestId);
  }

  function rememberHandledInjectRequest(requestId) {
    if (!requestId) {
      return;
    }
    handledInjectRequestIds.push(requestId);
    if (handledInjectRequestIds.length > MAX_HANDLED_INJECT_REQUEST_IDS) {
      handledInjectRequestIds.shift();
    }
  }

  let lastReportedProviderUrl = '';

  function notifyProviderLocation(provider, options = {}) {
    if (window.top === window || !provider) {
      return;
    }

    if (!options.force && window.location.href === lastReportedProviderUrl) {
      return;
    }
    lastReportedProviderUrl = window.location.href;

    try {
      window.parent.postMessage({
        type: 'INSIDEBAR_PROVIDER_LOCATION',
        provider,
        url: window.location.href
      }, '*');
    } catch (error) {
      console.warn('[Text Injection] Failed to report provider location:', error);
    }
  }

  // Handle text injection message
  function handleTextInjection(event) {
    // Validate event data structure
    if (!event || !event.data || typeof event.data !== 'object') {
      return;
    }

    // Only handle INJECT_TEXT messages
    if (event.data.type !== 'INJECT_TEXT') {
      return;
    }

    // Validate text payload
    const text = event.data.text;
    const autoSubmit = event.data.autoSubmit === true;
    const requestId = typeof event.data.requestId === 'string' ? event.data.requestId : '';
    if (!text || typeof text !== 'string' || text.length === 0) {
      console.warn('[Text Injection] Invalid text payload');
      return;
    }

    // Sanity check: reject extremely large payloads (> 1MB)
    if (text.length > 1048576) {
      console.error('[Text Injection] Text payload too large:', text.length, 'bytes');
      return;
    }

    const provider = detectProvider();
    if (!provider) {
      console.warn('Unknown provider, cannot inject text');
      return;
    }

    const selectors = PROVIDER_SELECTORS[provider];
    if (!selectors) {
      console.warn('No selectors configured for provider:', provider);
      return;
    }

    if (hasHandledInjectRequest(requestId)) {
      return;
    }
    rememberHandledInjectRequest(requestId);

    // Try each selector until we find an element
    let element = null;
    for (const selector of selectors) {
      element = findTextInputElement(selector);
      if (element) break;
    }

    if (element) {
      const success = injectTextIntoElement(element, text);
      if (!success) {
        console.error(`[Text Injection] Failed to inject text into ${provider}`);
      } else if (autoSubmit) {
        autoSubmitPrompt(provider);
      }
    } else {
      // Retry after a short delay in case page is still loading
      setTimeout(() => {
        let retryElement = null;
        for (const selector of selectors) {
          retryElement = findTextInputElement(selector);
          if (retryElement) {
            break;
          }
        }
        if (retryElement) {
          const success = injectTextIntoElement(retryElement, text);
          if (success && autoSubmit) {
            autoSubmitPrompt(provider);
          }
        } else {
          console.error(`[Text Injection] ${provider} editor not found`);
        }
      }, 1000);
    }
  }

  // Listen for messages from sidebar
  const provider = detectProvider();
  applyEmbeddedProviderLayout(provider);
  notifyProviderLocation(provider);
  window.addEventListener('message', handleTextInjection);
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'INSIDEBAR_PROVIDER_LOCATION_REQUEST') {
      notifyProviderLocation(detectProvider(), { force: true });
    }
  });
  window.addEventListener('popstate', () => notifyProviderLocation(detectProvider()));
  window.addEventListener('hashchange', () => notifyProviderLocation(detectProvider()));
  window.setInterval(() => notifyProviderLocation(detectProvider()), 1000);
})();
