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
- Real-provider setup/smoke: `REAL_PROVIDER=chatgpt npm run test:acceptance:real:setup` prepares the persistent live profile, and `REAL_PROVIDER=chatgpt npm run test:acceptance:real` records iframe/editor readiness and real prompt injection evidence.
- Unit: `tests/source-formatter.test.js` covers public URL inclusion and localhost/private URL exclusion.

## Decisions

- The portable framework is migrated, but the content is local to this project.
- Gaps are allowed in the matrix when they are explicit; they should not block unrelated work by pretending to be covered.
- Fake-provider acceptance is treated as deterministic routing evidence, not proof that all real provider DOMs still accept injection.
- Acceptance runs share `dist/insidebar-ai-chrome-unpacked`; run scenarios serially unless the harness is changed to isolate unpacked extension directories per process.

## Open Gaps

- `IB-INV-006`: the real-provider setup and smoke commands exist, but a successful live-provider `success.json` artifact is still needed before treating real provider editor readiness as fully covered.

## Gate

Run:

```bash
npm run test:quality-gate
```

For full local verification, run:

```bash
npm run test:required
```
