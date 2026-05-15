# Acceptance Workflow

This directory provides a BDD-like main-chain regression workflow for the extension.

## Files

- `spec.json`: user-facing scenarios (actions + assertions).
- `runner.mjs`: executes scenarios in Chrome for Testing.
- `helpers.mjs`: shared CFT/CDP, fixtures, and artifact logic.
- `check-spec.mjs`: validates scenario schema and references.
- `fixtures/`: local host pages and fake provider pages for deterministic selection/input behavior.

The browser runner patches only the generated unpacked extension under `dist/` so provider URLs point at the local fake provider fixture. Production source provider URLs are left untouched.

## Commands

- `npm run test:acceptance:spec`
  - validates `spec.json` before browser execution.
- `npm run test:acceptance`
  - runs spec validation, then scenario execution.
- `npm run test:acceptance:real:setup`
  - opens a visible real-provider Chrome session with a persistent profile for login/setup.
- `npm run test:acceptance:real`
  - runs a real-provider smoke scenario (no fake-provider patch) against one provider.
- `npm run test:e2e:cft`
  - alias of `test:acceptance` for compatibility.
- `npm run test:required`
  - unit tests plus acceptance gate.

Run acceptance scenarios serially. The runner prepares a shared unpacked extension under `dist/insidebar-ai-chrome-unpacked`, so parallel acceptance runs can race while patching fake-provider URLs.

## Real Provider Smoke

Use this command when you need evidence that a real provider iframe/editor path still accepts injected prompts:

```bash
REAL_PROVIDER=chatgpt npm run test:acceptance:real:setup
REAL_PROVIDER=chatgpt npm run test:acceptance:real
```

- Supported providers: `chatgpt`, `claude`, `gemini`, `google`, `grok`, `deepseek`
- The default persistent profile is `dist/acceptance-real-profile`; override with `CFT_PROFILE=/path/to/profile`
- Use `CFT_WINDOW_POSITION=3000,100` when the visible WSL/desktop window needs a specific offset
- Artifacts are written under: `dist/acceptance-artifacts-real/real-provider-<provider>-editor-ready/`
- This smoke requires a usable provider session/page state (for example, signed-in ChatGPT/Claude if they gate editors)
- Some providers may return anti-bot challenge pages in automation contexts; those runs fail with artifacts so the exact blocker is visible.

## Scenario Selection

Run a single scenario:

```bash
npm run test:acceptance -- --scenario selection-floating-dock-provider
```

Or:

```bash
SCENARIO=selection-floating-dock-provider npm run test:acceptance
```

## Failure Artifacts

On failure, artifacts are written to:

`dist/acceptance-artifacts/<scenario-id>/`

Includes:

- `error.txt`
- `targets.json` (CDP targets)
- `storage.json` (extension storage snapshot)
- `page.png`
- `page-contracts.json` (all `[data-testid]` elements from host page)
- `floating.png` / `floating-contracts.json` when the floating iframe exists
- `sidebar.png` / `sidebar-contracts.json` when the sidebar page exists
