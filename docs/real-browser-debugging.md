# Real Browser Debugging

This note captures the current best practice for debugging insidebar.ai against a real Chrome profile, real provider login state, and the unpacked extension.

## Why This Exists

The deterministic acceptance suite is intentionally fake-provider based. It proves extension-owned behavior: toolbar routing, prompt shape, provider tabs, dock/float lifecycle, storage, and auth fallback UI. It does not prove that a real provider still exposes an editor, permits iframe embedding, or accepts injected text today.

The real debugging loop must therefore keep two boundaries separate:

- Extension contract: local fake provider, repeatable, should gate normal changes.
- Provider reality: real ChatGPT/Claude/Gemini/etc., session-dependent, should classify auth, anti-bot, iframe, and editor readiness.

## Current Gotcha

Do not trust a plain Chrome command like this as proof that the extension loaded:

```powershell
chrome.exe `
  --user-data-dir=E:\Code\insidebar-ai\.chrome-profile `
  --load-extension=E:\Code\insidebar-ai
```

On the tested machine, Chrome 148 accepted the command line but `chrome://extensions` stayed empty. The selection toolbar then failed simply because the extension was not loaded.

Use Chrome DevTools MCP extension tools instead. In pipe mode it exposes `install_extension`, `list_extensions`, `reload_extension`, and `trigger_extension_action`, which gives a real installed unpacked extension inside the debug browser.

## Dedicated Profile

Use a dedicated profile and never the everyday browser profile:

```text
E:\Code\insidebar-ai\.chrome-profile
```

Sign in to providers once in that profile. The profile is ignored by git because it contains cookies and local browser state.

## One-Command Smoke

Run:

```bash
node scripts/debug-real-browser-mcp.mjs
```

Useful environment variables:

- `CHROME_PATH`: override Chrome executable path.
- `MCP_USER_DATA_DIR`: override the debug profile path.
- `MCP_PROVIDER_URL`: top-level provider URL used for login/editor classification. Default: `https://chatgpt.com/`.

The smoke downloads `chrome-devtools-mcp` into `.tmp/` when needed, launches Chrome through MCP pipe mode, installs the unpacked extension, and checks:

- the extension installs and is enabled
- the top-level provider page is classified as `editor_ready`, `auth_required`, `challenge_or_loading`, or `editor_not_detected`
- the selection toolbar appears on a normal web page
- Send opens the floating surface
- a later Summary action still routes through the floating surface

This smoke does not auto-submit real prompts to external AI services. Real send/submit behavior should remain explicit and opt-in.

Provider tab rotation and concrete prompt delivery are covered deterministically in `selection-floating-provider-rotation-sends`. A normal page cannot inspect the Chrome extension iframe DOM directly because it is cross-origin; do not mark real MCP provider-tab assertions as covered unless the test enters an extension target or uses an explicit extension MCP tool that exposes the surface.

## Provider Test Matrix

Use this split when a provider-related bug appears:

| Layer | Goal | Command |
| --- | --- | --- |
| Spec schema | Scenario metadata stays valid | `npm run test:acceptance:spec` |
| Fake-provider contract | Extension routing, provider tabs, prompt templates, dock/float state | `npm run test:acceptance` |
| Real browser MCP smoke | Real Chrome profile, real login state, unpacked extension installed by DevTools MCP | `node scripts/debug-real-browser-mcp.mjs` |
| Real provider diagnostic | Classify editor/auth/anti-bot for one provider | `REAL_PROVIDER=chatgpt npm run test:acceptance:real` |
| Real provider strict | Fail unless the provider editor is ready | `REAL_PROVIDER=chatgpt npm run test:acceptance:real:ready` |
| Interactive provider setup | Let a human clear login/challenge, then rerun strict smoke | `REAL_PROVIDER=chatgpt npm run test:acceptance:real:interactive` |

## Debugging Rules

- First prove the extension is really installed: `list_extensions` must show `insidebar.ai`.
- Then prove provider state separately: editor ready, auth required, or anti-bot blocked.
- Do not interpret an auth wall as an injection regression.
- Do not inspect cookies, local storage secrets, passwords, or session stores.
- Do not auto-submit real prompts unless the test is explicitly designed for that.
- Keep provider switching tests broad: ChatGPT, Claude, Gemini, Google, Grok, and DeepSeek should all be represented either in fake-provider acceptance or a real classified smoke.
- Keep failure artifacts. A screenshot plus target/page list is usually the fastest way to tell "extension did not load" from "provider did not load".
