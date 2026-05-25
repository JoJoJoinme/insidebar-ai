# Workboard

## Current Intent

Make the quality-contract workflow concrete for insidebar-ai so future user-visible changes name the intended behavior, invariant risk, evidence, and any remaining gap before they are treated as done.

## Baseline

- `tests/acceptance/spec.json` defines browser-real acceptance scenarios for floating provider docking and Ask auto-submit.
- `tests/source-formatter.test.js` covers source URL formatting and local/private URL redaction.
- `package.json` has `test:required` as the local required test command.

## Evidence

- Deterministic acceptance: `selection-floating-dock-provider` covers floating controls, provider tabs, provider switching, storage persistence, docking, and sidebar provider tabs.
- Deterministic acceptance: `selection-ask-autosubmit` covers Ask prompt handoff, auto-submit, docked sidebar continuation, local fixture URL redaction, and floating hidden state.
- Deterministic acceptance: `selection-sidepanel-direct-send` and `selection-sidepanel-direct-ask` cover direct sidebar mode for Send and Ask.
- Deterministic acceptance: `selection-action-explain-prompt`, `selection-action-translate-prompt`, and `selection-action-summary-prompt` cover toolbar prompt templates.
- Deterministic acceptance: `selection-floating-switched-provider-prompt` covers prompt injection after switching the floating provider.
- Deterministic acceptance: `selection-floating-provider-rotation-sends` covers provider rotation across Claude, Gemini, Google, Grok, and DeepSeek with concrete Explain, Translate, Summary, Ask, and Send actions.
- Real-provider setup/smoke: `REAL_PROVIDER=chatgpt npm run test:acceptance:real:setup` prepares the persistent live profile, and `REAL_PROVIDER=chatgpt npm run test:acceptance:real` records iframe/editor readiness and real prompt injection evidence.
- Real Chrome DevTools MCP smoke: `npm run debug:real-browser` installs the unpacked extension into `.chrome-profile`, checks real provider classification, and verifies toolbar/floating behavior without pretending that fake-provider contracts prove real provider editor readiness.
- Unit: `tests/source-formatter.test.js` covers public URL inclusion and localhost/private URL exclusion.

## Decisions

- The portable framework is migrated, but the content is local to this project.
- Gaps are allowed in the matrix when they are explicit; they should not block unrelated work by pretending to be covered.
- Fake-provider acceptance is treated as deterministic routing evidence, not proof that all real provider DOMs still accept injection.
- Acceptance runs share `dist/insidebar-ai-chrome-unpacked`; run scenarios serially unless the harness is changed to isolate unpacked extension directories per process.
- Real browser debugging should use Chrome DevTools MCP `install_extension` rather than trusting bare `chrome.exe --load-extension`, because recent Chrome builds can accept the command-line flag without actually loading the unpacked extension.

## Open Gaps

- `IB-INV-006`: the real-provider and DevTools MCP smoke commands exist, but real provider runs can still classify as auth/challenge/editor-not-detected depending on provider state. Treat these as provider-boundary evidence, not fake-provider regressions.

## Gate

Run:

```bash
npm run test:quality-gate
```

For full local verification, run:

```bash
npm run test:required
```
