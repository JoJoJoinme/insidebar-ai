import fs from 'node:fs';
import path from 'node:path';
import { AcceptanceHarness, assert, assertIncludes, repoRoot } from './helpers.mjs';

const specPath = process.env.ACCEPTANCE_SPEC || path.join(repoRoot, 'tests/acceptance/spec.json');
const scenarioFilter = readScenarioFilter();
const specs = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const selectedSpecs = scenarioFilter
  ? specs.filter((scenario) => scenario.id === scenarioFilter)
  : specs;

if (selectedSpecs.length === 0) {
  throw new Error(`No acceptance scenarios matched${scenarioFilter ? `: ${scenarioFilter}` : ''}`);
}

const harness = new AcceptanceHarness();

try {
  await harness.start();
  for (const scenario of selectedSpecs) {
    await runScenario(scenario);
  }
  console.log(`acceptance passed: ${selectedSpecs.map((scenario) => scenario.id).join(', ')}`);
} finally {
  await harness.stop();
}

async function runScenario(scenario) {
  console.log(`scenario: ${scenario.id}`);
  try {
    validateScenario(scenario);
    await harness.applySettings(scenario.settings || {});

    for (const step of scenario.steps) {
      if (step.action) {
        await runAction(step);
      } else if (step.assert) {
        await runAssertion(step);
      } else {
        throw new Error(`Step must include action or assert: ${JSON.stringify(step)}`);
      }
    }
  } catch (error) {
    await harness.writeFailureArtifacts(scenario.id, error);
    throw error;
  }
}

async function runAction(step) {
  switch (step.action) {
    case 'openPage':
      await harness.openFixture(required(step.fixture, 'openPage.fixture'));
      break;
    case 'selectText':
      await harness.selectText(required(step.target, 'selectText.target'));
      break;
    case 'clickToolbarAction':
      await harness.clickToolbarAction(required(step.name, 'clickToolbarAction.name'));
      break;
    case 'switchFloatingProvider':
      await harness.switchFloatingProvider(required(step.provider, 'switchFloatingProvider.provider'));
      break;
    case 'dockFloating':
      await harness.dockFloating();
      break;
    default:
      throw new Error(`Unknown acceptance action: ${step.action}`);
  }
}

async function runAssertion(step) {
  switch (step.assert) {
    case 'selectionToolbarVisible': {
      const state = await harness.readToolbarState();
      assert(state.visible, `selection toolbar should be visible: ${JSON.stringify(state)}`);
      break;
    }
    case 'floatingVisible': {
      const state = await harness.readOuterFloatingState();
      assert(state.visible, `floating window should be visible: ${JSON.stringify(state)}`);
      break;
    }
    case 'floatingTopControls': {
      const state = await harness.readOuterFloatingState();
      for (const testId of step.includes || []) {
        assertIncludes(state.controls, testId);
      }
      break;
    }
    case 'floatingProviderTabs': {
      const layout = await harness.readFloatingLayout();
      if (step.activeProvider) {
        assert(layout.activeProvider === step.activeProvider,
          `expected floating active provider ${step.activeProvider}, got ${layout.activeProvider}`);
      }
      if (step.iconOnly) {
        assert(layout.tabsText === '', `expected icon-only provider tabs, got text "${layout.tabsText}"`);
      }
      if (step.position === 'bottom') {
        assert(layout.tabs.height > 0, 'provider tabs should be visible');
        assert(layout.tabs.bottom <= layout.innerHeight + 1, 'provider tabs must stay inside floating viewport');
        assert(layout.shell.bottom <= layout.tabs.top + 1, 'provider shell must not overlap provider tabs');
      }
      assertIncludes(layout.providerTitles, 'ChatGPT');
      break;
    }
    case 'embeddedChatgptHeaderHidden': {
      const layout = await harness.readEmbeddedChatgptLayout();
      assert(layout.hasLayoutStyle, 'embedded ChatGPT layout style should be injected');
      assert(layout.headerDisplay === 'none', `embedded ChatGPT header should be hidden, got ${layout.headerDisplay}`);
      break;
    }
    case 'floatingProvider': {
      const layout = await harness.readFloatingLayout();
      assert(layout.activeProvider === step.provider,
        `expected floating provider ${step.provider}, got ${layout.activeProvider}`);
      break;
    }
    case 'storageProvider': {
      const provider = await harness.readStorageProvider();
      assert(provider === step.provider, `expected storage provider ${step.provider}, got ${provider}`);
      break;
    }
    case 'sidebarProvider': {
      const state = await harness.readSidebarState();
      assert(state.activeProvider === step.provider,
        `expected sidebar provider ${step.provider}, got ${state.activeProvider}`);
      assert(state.providerVisible === 'flex', `expected sidebar provider view visible, got ${state.providerVisible}`);
      break;
    }
    case 'sidebarProviderTabsOnly': {
      const state = await harness.readSidebarState();
      assert(
        state.bottomTestIds.every((testId) => testId.startsWith('sidebar-provider-tab-')),
        `sidebar bottom tabs should only contain providers: ${JSON.stringify(state.bottomTestIds)}`
      );
      break;
    }
    default:
      throw new Error(`Unknown acceptance assertion: ${step.assert}`);
  }
}

function validateScenario(scenario) {
  for (const field of ['id', 'intent', 'steps']) {
    if (!scenario[field]) {
      throw new Error(`Scenario missing ${field}: ${JSON.stringify(scenario)}`);
    }
  }
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    throw new Error(`Scenario ${scenario.id} must include non-empty steps`);
  }
}

function required(value, label) {
  if (value == null || value === '') {
    throw new Error(`Missing required field: ${label}`);
  }
  return value;
}

function readScenarioFilter() {
  const fromEnv = process.env.SCENARIO;
  const index = process.argv.indexOf('--scenario');
  if (index !== -1 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fromEnv || null;
}
