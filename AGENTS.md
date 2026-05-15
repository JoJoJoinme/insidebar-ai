# Repository Guidelines

## Project Structure & Module Organization

This repository is a Manifest V3 browser extension. Core extension wiring lives in `manifest.json` and `background/service-worker.js`. Shared logic is in `modules/` (`settings.js`, `providers.js`, `history-manager.js`, etc.). UI surfaces are split by feature: `sidebar/`, `options/`, `floating/`, and `content-scripts/`. Static assets live in `icons/`, `Screenshots/`, `data/`, and `_locales/`. Tests are in `tests/` and generally mirror module names, for example `modules/settings.js` -> `tests/settings.test.js`.

## Build, Test, and Development Commands

Install dependencies with:

```bash
npm install
```

Run the full test suite:

```bash
npm test -- --run
```

Run tests in watch mode:

```bash
npm run test:watch
```

Generate coverage output using V8 coverage:

```bash
npm run test:coverage
```

Lint the extension package with Mozilla `web-ext`:

```bash
npm run lint
```

For browser testing, load the repository root or a prepared unpacked extension directory in Chrome/Chromium via `chrome://extensions` with Developer Mode enabled.

## Coding Style & Naming Conventions

Use modern JavaScript modules where the existing file does. Follow the current style: two-space indentation, semicolons, single quotes in most JavaScript, and descriptive camelCase identifiers. Keep content-script code defensive because it runs on arbitrary websites. Prefer existing helpers in `modules/` before adding new utilities. Keep CSS selectors scoped to the relevant surface, especially content scripts, to avoid leaking styles into host pages.

## Testing Guidelines

Tests use Vitest with `happy-dom`; setup is in `tests/setup.js` and configuration is in `vitest.config.js`. Add or update tests when changing shared modules, message handling, provider behavior, or storage logic. Name test files `*.test.js`, colocated under `tests/`. Before submitting, run `npm test -- --run`; use `npm run test:coverage` for broader changes.

## Quality Contract

Before changing user-visible behavior, read `docs/behavior-contract.md`, `docs/verification-matrix.json`, and `docs/workboard.md`. Name the user task and invariant being changed before treating the implementation as complete.

Update `docs/verification-matrix.json` for every user-visible behavior change. Each invariant must be marked `covered`, `gap`, or `exploratory`; a gap is allowed only when its risk and next proof are explicit. Use deterministic acceptance or unit coverage where possible, and keep fake-provider evidence separate from real-provider/manual evidence.

Run `npm run test:quality-gate` after matrix edits. Run `npm run test:required` before handoff when the change affects extension behavior.

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries such as `Remove Microsoft Copilot provider` and `Add floating utility view controls`. Keep commits focused and avoid mixing unrelated refactors. Pull requests should include a concise description, affected surfaces, test results, and screenshots or screen recordings for UI changes. Link related issues when available and call out any provider-specific behavior that needs manual verification.

## Security & Configuration Tips

Do not commit secrets, browser profiles, or generated `dist/` artifacts unless explicitly required for a release. Keep host permissions and `web_accessible_resources` as narrow as practical. When adding a provider, update manifest entries, provider metadata, icons, injection scripts, and tests together.
