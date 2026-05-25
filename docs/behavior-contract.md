# Insidebar AI Behavior Contract

This contract names the user-visible behavior that must survive local changes. It is intentionally about tasks and state transitions, not implementation details.

## Scope

Insidebar AI is a Manifest V3 browser extension with these user-visible surfaces:

- selection toolbar on arbitrary pages
- floating provider window
- sidebar provider view
- provider tabs and provider state
- source formatting for content sent to providers

## Current User Tasks

### IB-TASK-001: Send Selected Text To Floating Provider

When the user selects page text and clicks Send, the extension opens the floating provider view, keeps the expected floating controls visible, uses the remembered provider, and hides duplicated provider headers inside the embedded provider frame.

### IB-TASK-002: Switch Provider And Dock Without Losing State

When the user switches provider inside floating mode and docks the floating window, the selected provider remains the active sidebar provider. Docking must not reset provider tabs or return the provider frame to a home page.

### IB-TASK-003: Ask About Selected Text With Auto Submit

When the user clicks Ask, enters a question, and submits it, the provider receives a prompt that includes the user question and selected content. The initial Ask submission is allowed to auto-submit.

### IB-TASK-004: Continue From Sidebar After Docking

After floating content has been docked, later selection toolbar actions should route to the sidebar provider instead of reopening floating state. The sidebar provider URL and conversation state must be preserved.

### IB-TASK-005: Include Source Only When It Is Safe To Share

Prompts may include public source URLs, but local, loopback, and private-network URLs must not be sent to providers.

### IB-TASK-006: Use Toolbar Action Templates

Explain, Translate, and Summary must wrap selected text with the intended prompt template before sending it to a provider.

### IB-TASK-007: Send Directly To Sidebar

When the user configures selection toolbar open mode as sidebar, Send and Ask must open the sidebar provider directly and must not create a floating window.

### IB-TASK-008: Continue Floating With The Selected Provider

After the user switches provider in floating mode, later selection toolbar actions must inject into the selected provider, not the original default provider.

### IB-TASK-009: Escape Embedded Provider Auth Walls

When a provider sign-in wall appears inside floating or docked iframe mode, the extension must offer a normal-tab fallback instead of treating the wall as a prompt-injection failure.

### IB-TASK-010: Keep Docked And Floating Surfaces Exclusive

When the user docks floating content or opens the side panel, the page-level floating window must not remain visible as a duplicate provider surface.

### IB-TASK-011: Rotate Providers And Send Real Actions

When the user changes providers in floating mode and then chooses Send, Explain, Translate, Summary, or Ask, the active provider must receive the corresponding current prompt and action semantics.

## Invariants

### IB-INV-001: Floating Chrome Stability

Floating mode must expose the expected top controls and icon-only provider tabs in a stable layout.

### IB-INV-002: Provider Selection Persistence

Provider selection must persist across floating provider switch, storage state, and docking into sidebar.

### IB-INV-003: Ask Auto Submit Semantics

Ask submission must send a single prompt with the question included and auto-submit enabled for the initial provider handoff.

### IB-INV-004: Docked Sidebar Continuation

After docking, later selection toolbar actions must target the sidebar provider, keep floating hidden, and preserve the existing sidebar provider URL.

### IB-INV-005: Private Source Redaction

Local, loopback, and private-network source URLs must be excluded from provider prompts.

### IB-INV-006: Fake Provider Boundary

Acceptance tests that use a fake provider prove extension routing and prompt shape. They do not prove that every real provider iframe/editor still accepts injection, auto-submit, or docked continuation.

### IB-INV-007: Sidebar Direct Routing

When `selectionToolbarOpenMode` is `sidePanel`, selection toolbar Send and Ask must route directly to the sidebar provider, preserve prompt shape, and keep floating hidden.

### IB-INV-008: Toolbar Template Integrity

Explain, Translate, and Summary must send their specific prompt instructions rather than raw selected text or another action's template.

### IB-INV-009: Switched Floating Provider Injection

After switching the floating provider, the next selected-text prompt must be injected into that provider and use the current selection.

### IB-INV-010: Embedded Auth Fallback

Provider auth walls must surface a normal-tab fallback from both floating and docked views.

### IB-INV-011: Dock Float Mutual Exclusion

Floating and docked provider surfaces must not remain visible at the same time.

### IB-INV-012: Provider Rotation Send Coverage

Provider tab rotation must be covered with concrete sends across multiple providers and toolbar actions, not only with visual active-tab assertions.

## Baseline Classification

- `baseline_sufficient`: existing deterministic tests cover the exact invariant and are wired into the required gate.
- `baseline_gap`: the invariant is known but lacks repeatable proof.
- `exploratory_spike`: the behavior is still being investigated; merge gates should record what evidence exists and what remains unknown.

## Maintenance Rule

Every user-visible behavior change must update `docs/verification-matrix.json` with one of `covered`, `gap`, or `exploratory`. A `gap` is acceptable only when it states the risk and the next proof needed.
