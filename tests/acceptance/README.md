# Acceptance Workflow

This directory provides a BDD-like main-chain regression workflow for the extension.

## Files

- `spec.json`: user-facing scenarios (actions + assertions).
- `runner.mjs`: executes scenarios in Chrome for Testing.
- `helpers.mjs`: shared CFT/CDP, fixtures, and artifact logic.
- `check-spec.mjs`: validates scenario schema and references.
- `fixtures/`: local test pages for deterministic selection/input behavior.

## Commands

- `npm run test:acceptance:spec`
  - validates `spec.json` before browser execution.
- `npm run test:acceptance`
  - runs spec validation, then scenario execution.
- `npm run test:e2e:cft`
  - alias of `test:acceptance` for compatibility.
- `npm run test:required`
  - unit tests plus acceptance gate.

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
