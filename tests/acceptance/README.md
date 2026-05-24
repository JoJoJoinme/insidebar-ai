# Acceptance Workflow

This directory provides a BDD-like main-chain regression workflow for the extension.

## Files

- `spec.json`: user-facing scenarios (tier metadata + actions + assertions).
- `runner.mjs`: executes scenarios in Chrome for Testing.
- `helpers.mjs`: shared CFT/CDP, fixtures, and artifact logic.
- `check-spec.mjs`: validates scenario schema and references.
- `fixtures/`: local host pages and fake provider pages for deterministic selection/input behavior.

The browser runner patches only a generated unpacked extension copy so provider URLs point at the local fake provider fixture. Production source provider URLs are left untouched. By default each harness gets an isolated temp unpacked directory; set `EXT_DIR` only when you intentionally want to inspect or reuse one generated copy.

## Test Tiers

- `extension-contract`: deterministic local scenarios for extension UI, storage, routing, prompt templates, and fake-provider injection contracts.
- `provider-boundary`: deterministic scenarios that model real provider states, such as an auth wall, without letting tests directly fake extension events.
- `browser-env`: smoke checks for the automation browser/profile environment itself, such as storage roundtrips and startup noise.

`spec.json` scenarios must declare the user journey, mock contract, and real boundary. The fake provider supports explicit modes through `providerModes`: `editor-ready`, `editor-delayed`, `editor-missing`, and `auth-wall`.

## Commands

- `npm run test:acceptance:spec`
  - validates `spec.json` before browser execution.
- `npm run test:acceptance`
  - runs spec validation, then scenario execution.
- `npm run test:acceptance:real:setup`
  - opens a visible real-provider Chrome session with a persistent profile for login/setup.
- `npm run test:acceptance:real`
  - runs a real-provider smoke scenario (no fake-provider patch) against one provider and classifies `editor_ready`, `auth_required`, or `anti_bot_blocked`.
- `npm run test:acceptance:browser-env`
  - runs a browser/profile smoke scenario for storage and startup-noise visibility.
- `npm run test:e2e:cft`
  - alias of `test:acceptance` for compatibility.
- `npm run test:required`
  - unit tests plus acceptance gate.

Run acceptance scenarios serially unless every process has its own `EXT_DIR` and browser profile. Reusing one `EXT_DIR` across parallel runs can race while patching fake-provider URLs.

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
- Some providers may return auth or anti-bot challenge pages in automation contexts; those runs are classified with artifacts instead of being treated as fake-provider regressions.

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
