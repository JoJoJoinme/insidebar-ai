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

let harness = null;

try {
  for (const scenario of selectedSpecs) {
    harness = new AcceptanceHarness();
    await harness.start();
    await runScenario(scenario);
    await harness.stop();
    harness = null;
  }
  console.log(`acceptance passed: ${selectedSpecs.map((scenario) => scenario.id).join(', ')}`);
} finally {
  if (harness) {
    await harness.stop();
  }
}

async function runScenario(scenario) {
  console.log(`scenario: ${scenario.id}`);
  harness.beginScenario();
  try {
    validateScenario(scenario);
    await harness.applySettings(scenario.settings || {});

    for (const step of scenario.steps) {
      if (process.env.ACCEPTANCE_TRACE === '1') {
        console.log(`step: ${JSON.stringify(step)}`);
      }
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
  } finally {
    if (process.env.ACCEPTANCE_TRACE === '1') {
      console.log(`cleanup: ${scenario.id}`);
    }
    await harness.endScenario();
    if (process.env.ACCEPTANCE_TRACE === '1') {
      console.log(`cleanup done: ${scenario.id}`);
    }
  }
}

async function runAction(step) {
  assertStepShape(step, ['action'], `action step ${step.action}`);

  switch (step.action) {
    case 'openPage':
      await harness.openFixture(required(step.fixture, 'openPage.fixture'));
      break;
    case 'selectText':
      await harness.selectText(required(step.target, 'selectText.target'));
      break;
    case 'clickToolbarAction':
      await harness.clickToolbarAction(required(step.name, 'clickToolbarAction.name'));
      if (step.waitForFloating !== false) {
        await harness.waitForFloating();
      }
      break;
    case 'switchFloatingProvider':
      await harness.switchFloatingProvider(required(step.provider, 'switchFloatingProvider.provider'));
      break;
    case 'submitAskQuestion':
      await harness.submitAskQuestion(required(step.question, 'submitAskQuestion.question'), {
        waitForFloating: step.waitForFloating !== false
      });
      break;
    case 'dockFloating':
      await harness.dockFloating();
      break;
    default:
      throw new Error(`Unknown acceptance action: ${step.action}`);
  }
}

async function runAssertion(step) {
  assertStepShape(step, ['assert'], `assertion step ${step.assert}`);

  switch (step.assert) {
    case 'selectionToolbarVisible': {
      const state = await harness.readToolbarState();
      assert(state.visible, `selection toolbar should be visible: ${JSON.stringify(state)}`);
      if (step.openMode) {
        assert(state.openMode === step.openMode,
          `expected selection toolbar openMode ${step.openMode}, got ${JSON.stringify(state)}`);
      }
      break;
    }
    case 'floatingVisible': {
      const state = await harness.readOuterFloatingState();
      assert(state.visible, `floating window should be visible: ${JSON.stringify(state)}`);
      break;
    }
    case 'floatingHidden': {
      const state = await harness.readOuterFloatingHiddenState();
      assert(state.hidden, `floating window should be hidden: ${JSON.stringify(state)}`);
      break;
    }
    case 'askPanelVisible': {
      const state = await harness.readAskPanelState();
      assert(state.visible, `ask panel should be visible: ${JSON.stringify(state)}`);
      if (step.quoteIncludes) {
        assert(
          state.quoteText.includes(step.quoteIncludes),
          `expected ask quote to include "${step.quoteIncludes}", got "${state.quoteText}"`
        );
      }
      break;
    }
    case 'floatingTopControls': {
      const state = await harness.readOuterFloatingState();
      if (step.equals) {
        assertSameArray(state.controls, step.equals, 'floating top controls');
      }
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
      if (step.providerTitles) {
        assertSameArray(layout.providerTitles, step.providerTitles, 'floating provider titles');
      } else {
        assertIncludes(layout.providerTitles, 'ChatGPT');
      }
      break;
    }
    case 'embeddedProviderHeaderHidden': {
      const layout = await harness.readEmbeddedProviderLayout(required(step.provider, 'embeddedProviderHeaderHidden.provider'));
      assert(layout.hasLayoutStyle, `embedded ${step.provider} layout style should be injected`);
      assert(layout.headerDisplay === 'none', `embedded ${step.provider} header should be hidden, got ${layout.headerDisplay}`);
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
    case 'floatingReferenceQuestion': {
      const state = await harness.readFloatingReference();
      assert(state.question.includes(step.includes), `expected floating question to include "${step.includes}", got "${state.question}"`);
      break;
    }
    case 'floatingAutoSubmit': {
      const state = await harness.readFloatingInjectionState();
      assert(state.autoSubmit === String(step.value), `expected floating autoSubmit ${step.value}, got ${state.autoSubmit}`);
      if (step.minPromptLength != null) {
        assert(state.promptLength >= step.minPromptLength, `expected prompt length >= ${step.minPromptLength}, got ${state.promptLength}`);
      }
      break;
    }
    case 'providerReceivedPrompt': {
      const state = await harness.readProviderInjectionState(required(step.provider, 'providerReceivedPrompt.provider'), {
        waitForSubmit: step.submitted === true
      });
      if (step.includes) {
        assert(
          state.inputValue.includes(step.includes) || state.submittedText.includes(step.includes),
          `expected fake ${step.provider} prompt to include "${step.includes}", got "${state.inputValue || state.submittedText}"`
        );
      }
      if (step.excludes) {
        assert(
          !state.inputValue.includes(step.excludes) && !state.submittedText.includes(step.excludes),
          `expected fake ${step.provider} prompt to exclude "${step.excludes}", got "${state.inputValue || state.submittedText}"`
        );
      }
      if (step.autoSubmit != null) {
        assert(
          state.messageAutoSubmit === String(step.autoSubmit),
          `expected fake ${step.provider} autoSubmit ${step.autoSubmit}, got ${state.messageAutoSubmit}`
        );
      }
      if (step.submitted != null) {
        const didSubmit = state.submitCount > 0;
        assert(didSubmit === step.submitted, `expected fake ${step.provider} submitted ${step.submitted}, got ${didSubmit}`);
      }
      if (step.minPromptLength != null) {
        assert(state.inputLength >= step.minPromptLength, `expected fake ${step.provider} prompt length >= ${step.minPromptLength}, got ${state.inputLength}`);
      }
      break;
    }
    case 'sidebarProviderReceivedPrompt': {
      const state = await harness.readSidebarProviderInjectionState(required(step.provider, 'sidebarProviderReceivedPrompt.provider'), {
        waitForSubmit: step.submitted === true
      });
      if (step.includes) {
        assert(
          state.inputValue.includes(step.includes) || state.submittedText.includes(step.includes),
          `expected sidebar fake ${step.provider} prompt to include "${step.includes}", got "${state.inputValue || state.submittedText}"`
        );
      }
      if (step.excludes) {
        assert(
          !state.inputValue.includes(step.excludes) && !state.submittedText.includes(step.excludes),
          `expected sidebar fake ${step.provider} prompt to exclude "${step.excludes}", got "${state.inputValue || state.submittedText}"`
        );
      }
      if (step.autoSubmit != null) {
        assert(
          state.messageAutoSubmit === String(step.autoSubmit),
          `expected sidebar fake ${step.provider} autoSubmit ${step.autoSubmit}, got ${state.messageAutoSubmit}`
        );
      }
      if (step.submitted != null) {
        const didSubmit = state.submitCount > 0;
        assert(didSubmit === step.submitted, `expected sidebar fake ${step.provider} submitted ${step.submitted}, got ${didSubmit}`);
      }
      if (step.minPromptLength != null) {
        assert(state.inputLength >= step.minPromptLength, `expected sidebar fake ${step.provider} prompt length >= ${step.minPromptLength}, got ${state.inputLength}`);
      }
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
    case 'sidebarProviderUrl': {
      const state = await harness.readSidebarState();
      assert(
        state.providerFrameUrl.includes(step.includes),
        `expected sidebar provider URL to include "${step.includes}", got "${state.providerFrameUrl}"`
      );
      break;
    }
    case 'sidebarProviderTabsOnly': {
      const state = await harness.readSidebarState();
      assert(
        state.bottomTestIds.length > 0 && state.bottomTestIds.every((testId) => testId.startsWith('sidebar-provider-tab-')),
        `sidebar bottom tabs should only contain providers: ${JSON.stringify(state.bottomTestIds)}`
      );
      if (step.providers) {
        assertSameArray(
          state.bottomTestIds,
          step.providers.map((provider) => `sidebar-provider-tab-${provider}`),
          'sidebar provider tabs'
        );
      }
      break;
    }
    default:
      throw new Error(`Unknown acceptance assertion: ${step.assert}`);
  }
}

function validateScenario(scenario) {
  assertAllowedKeys(scenario, ['id', 'intent', 'runner', 'settings', 'steps'], `Scenario ${scenario.id || '<unknown>'}`);

  for (const field of ['id', 'intent', 'runner', 'steps']) {
    if (!scenario[field]) {
      throw new Error(`Scenario missing ${field}: ${JSON.stringify(scenario)}`);
    }
  }
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    throw new Error(`Scenario ${scenario.id} must include non-empty steps`);
  }
}

function assertStepShape(step, baseKeys, label) {
  const actionKeys = {
    openPage: ['action', 'fixture'],
    selectText: ['action', 'target'],
    clickToolbarAction: ['action', 'name', 'waitForFloating'],
    switchFloatingProvider: ['action', 'provider'],
    submitAskQuestion: ['action', 'question', 'waitForFloating'],
    dockFloating: ['action']
  };
  const assertionKeys = {
    selectionToolbarVisible: ['assert', 'openMode'],
    floatingVisible: ['assert'],
    floatingHidden: ['assert'],
    askPanelVisible: ['assert', 'quoteIncludes'],
    floatingTopControls: ['assert', 'includes', 'equals'],
    floatingProviderTabs: ['assert', 'activeProvider', 'iconOnly', 'position', 'providerTitles'],
    embeddedProviderHeaderHidden: ['assert', 'provider'],
    embeddedChatgptHeaderHidden: ['assert'],
    floatingProvider: ['assert', 'provider'],
    floatingReferenceQuestion: ['assert', 'includes'],
    floatingAutoSubmit: ['assert', 'value', 'minPromptLength'],
    providerReceivedPrompt: ['assert', 'provider', 'includes', 'excludes', 'autoSubmit', 'submitted', 'minPromptLength'],
    sidebarProviderReceivedPrompt: ['assert', 'provider', 'includes', 'excludes', 'autoSubmit', 'submitted', 'minPromptLength'],
    storageProvider: ['assert', 'provider'],
    sidebarProvider: ['assert', 'provider'],
    sidebarProviderUrl: ['assert', 'includes'],
    sidebarProviderTabsOnly: ['assert', 'providers']
  };

  const allowed = step.action ? actionKeys[step.action] : assertionKeys[step.assert];
  if (!allowed) {
    return;
  }
  assertAllowedKeys(step, allowed, label);

  const hasAction = Object.prototype.hasOwnProperty.call(step, 'action');
  const hasAssert = Object.prototype.hasOwnProperty.call(step, 'assert');
  assert(hasAction !== hasAssert, `Step must include exactly one of action or assert: ${JSON.stringify(step)}`);

  for (const key of baseKeys) {
    assert(Object.prototype.hasOwnProperty.call(step, key), `${label} missing ${key}: ${JSON.stringify(step)}`);
  }
}

function required(value, label) {
  if (value == null || value === '') {
    throw new Error(`Missing required field: ${label}`);
  }
  return value;
}

function assertAllowedKeys(value, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  const unknownKeys = Object.keys(value).filter((key) => !allowed.has(key));
  assert(unknownKeys.length === 0, `${label} includes unknown field(s): ${unknownKeys.join(', ')}`);
}

function assertSameArray(actual, expected, label) {
  assert(Array.isArray(actual), `${label} actual value should be an array`);
  assert(Array.isArray(expected), `${label} expected value should be an array`);
  assert(
    actual.length === expected.length && actual.every((value, index) => value === expected[index]),
    `expected ${label} ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

function readScenarioFilter() {
  const fromEnv = process.env.SCENARIO;
  const index = process.argv.indexOf('--scenario');
  if (index !== -1 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fromEnv || null;
}
