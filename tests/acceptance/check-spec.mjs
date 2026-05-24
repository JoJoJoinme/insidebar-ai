import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './helpers.mjs';

const specPath = process.env.ACCEPTANCE_SPEC || path.join(repoRoot, 'tests/acceptance/spec.json');
const fixtureDir = path.join(repoRoot, 'tests/acceptance/fixtures');
const specs = readJson(specPath);

const actions = new Set([
  'openPage',
  'selectText',
  'clickToolbarAction',
  'switchFloatingProvider',
  'submitAskQuestion',
  'closeFloating',
  'setSelectionToolbarOpenMode',
  'dockFloating'
]);

const actionFields = {
  openPage: ['action', 'fixture'],
  selectText: ['action', 'target'],
  clickToolbarAction: ['action', 'name', 'waitForFloating'],
  switchFloatingProvider: ['action', 'provider'],
  submitAskQuestion: ['action', 'question', 'waitForFloating'],
  closeFloating: ['action'],
  setSelectionToolbarOpenMode: ['action', 'mode'],
  dockFloating: ['action']
};

const assertions = new Set([
  'selectionToolbarVisible',
  'floatingVisible',
  'floatingHidden',
  'askPanelVisible',
  'floatingTopControls',
  'floatingProviderTabs',
  'embeddedProviderHeaderHidden',
  'embeddedChatgptHeaderHidden',
  'floatingProvider',
  'floatingAuthHelper',
  'floatingReferenceQuestion',
  'floatingAutoSubmit',
  'providerReceivedPrompt',
  'sidebarProviderReceivedPrompt',
  'storageProvider',
  'sidebarProvider',
  'sidebarProviderUrl',
  'sidebarProviderTabsOnly'
]);

const assertionFields = {
  selectionToolbarVisible: ['assert', 'openMode'],
  floatingVisible: ['assert'],
  floatingHidden: ['assert'],
  askPanelVisible: ['assert', 'quoteIncludes'],
  floatingTopControls: ['assert', 'includes', 'equals'],
  floatingProviderTabs: ['assert', 'activeProvider', 'iconOnly', 'position', 'providerTitles'],
  embeddedProviderHeaderHidden: ['assert', 'provider'],
  embeddedChatgptHeaderHidden: ['assert'],
  floatingProvider: ['assert', 'provider'],
  floatingAuthHelper: ['assert', 'provider', 'textIncludes', 'buttonText'],
  floatingReferenceQuestion: ['assert', 'includes'],
  floatingAutoSubmit: ['assert', 'value', 'minPromptLength'],
  providerReceivedPrompt: ['assert', 'provider', 'includes', 'excludes', 'autoSubmit', 'submitted', 'minPromptLength'],
  sidebarProviderReceivedPrompt: ['assert', 'provider', 'includes', 'excludes', 'autoSubmit', 'submitted', 'minPromptLength'],
  storageProvider: ['assert', 'provider'],
  sidebarProvider: ['assert', 'provider'],
  sidebarProviderUrl: ['assert', 'includes'],
  sidebarProviderTabsOnly: ['assert', 'providers']
};

const providers = new Set(['chatgpt', 'claude', 'gemini', 'google', 'grok', 'deepseek']);
const runners = new Set(['cft']);
const tiers = new Set(['extension-contract', 'provider-boundary', 'browser-env']);
const providerModes = new Set(['editor-ready', 'editor-delayed', 'editor-missing', 'auth-wall']);

function fail(message) {
  console.error(`acceptance spec failed: ${message}`);
  process.exit(1);
}

if (!Array.isArray(specs) || specs.length === 0) {
  fail('spec must be a non-empty array');
}

const ids = new Set();

for (const scenario of specs) {
  requireOnlyFields(
    scenario,
    ['id', 'intent', 'tier', 'journey', 'mockContract', 'realBoundary', 'runner', 'providerModes', 'settings', 'steps'],
    'scenario'
  );
  requireString(scenario.id, 'scenario.id');
  requireString(scenario.intent, `${scenario.id}.intent`);
  requireString(scenario.tier, `${scenario.id}.tier`);
  requireString(scenario.journey, `${scenario.id}.journey`);
  requireString(scenario.mockContract, `${scenario.id}.mockContract`);
  requireString(scenario.realBoundary, `${scenario.id}.realBoundary`);

  if (ids.has(scenario.id)) {
    fail(`duplicate scenario id: ${scenario.id}`);
  }
  ids.add(scenario.id);

  if (!runners.has(scenario.runner)) {
    fail(`${scenario.id}: unsupported runner "${scenario.runner}"`);
  }

  if (!tiers.has(scenario.tier)) {
    fail(`${scenario.id}: unsupported tier "${scenario.tier}"`);
  }

  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    fail(`${scenario.id}: steps must be a non-empty array`);
  }

  validateProviderModes(scenario.id, scenario.providerModes);
  validateSettings(scenario.id, scenario.settings || {});

  for (const [index, step] of scenario.steps.entries()) {
    const context = `${scenario.id}.steps[${index}]`;
    const hasAction = Object.prototype.hasOwnProperty.call(step, 'action');
    const hasAssert = Object.prototype.hasOwnProperty.call(step, 'assert');
    if (hasAction === hasAssert) {
      fail(`${context}: step must include exactly one of action or assert`);
    }

    if (hasAction) {
      validateAction(context, step);
    } else if (hasAssert) {
      validateAssertion(context, step);
    }
  }
}

console.log(`acceptance spec passed: ${specs.length} scenario(s)`);

function validateSettings(context, settings) {
  if (settings.selectionToolbarOpenMode && !['floating', 'sidePanel'].includes(settings.selectionToolbarOpenMode)) {
    fail(`${context}: invalid selectionToolbarOpenMode "${settings.selectionToolbarOpenMode}"`);
  }

  for (const key of ['lastSelectedProvider', 'defaultProvider']) {
    if (settings[key] && !providers.has(settings[key])) {
      fail(`${context}: invalid ${key} "${settings[key]}"`);
    }
  }

  if (settings.enabledProviders) {
    if (!Array.isArray(settings.enabledProviders) || settings.enabledProviders.length === 0) {
      fail(`${context}: enabledProviders must be a non-empty array`);
    }
    for (const provider of settings.enabledProviders) {
      if (!providers.has(provider)) {
        fail(`${context}: invalid enabled provider "${provider}"`);
      }
    }
  }
}

function validateAction(context, step) {
  if (!actions.has(step.action)) {
    fail(`${context}: unknown action "${step.action}"`);
  }
  requireOnlyFields(step, actionFields[step.action], context);

  if (step.action === 'openPage') {
    requireString(step.fixture, `${context}.fixture`);
    const fixturePath = path.join(fixtureDir, step.fixture);
    if (!fixturePath.startsWith(fixtureDir) || !fs.existsSync(fixturePath)) {
      fail(`${context}: fixture does not exist: ${step.fixture}`);
    }
  }

  if (step.action === 'selectText') {
    requireString(step.target, `${context}.target`);
  }

  if (step.action === 'clickToolbarAction') {
    requireString(step.name, `${context}.name`);
    if (step.waitForFloating != null && typeof step.waitForFloating !== 'boolean') {
      fail(`${context}.waitForFloating must be boolean when provided`);
    }
  }

  if (step.action === 'switchFloatingProvider') {
    requireProvider(step.provider, `${context}.provider`);
  }

  if (step.action === 'setSelectionToolbarOpenMode' && !['floating', 'sidePanel'].includes(step.mode)) {
    fail(`${context}.mode must be floating or sidePanel`);
  }

  if (step.action === 'submitAskQuestion') {
    requireString(step.question, `${context}.question`);
    if (step.waitForFloating != null && typeof step.waitForFloating !== 'boolean') {
      fail(`${context}.waitForFloating must be boolean when provided`);
    }
  }
}

function validateProviderModes(context, modes) {
  if (modes == null) {
    return;
  }

  if (typeof modes !== 'object' || Array.isArray(modes)) {
    fail(`${context}: providerModes must be an object`);
  }

  for (const [provider, mode] of Object.entries(modes)) {
    if (!providers.has(provider)) {
      fail(`${context}: providerModes contains invalid provider "${provider}"`);
    }
    if (!providerModes.has(mode)) {
      fail(`${context}: providerModes.${provider} must be one of ${[...providerModes].join(', ')}`);
    }
  }
}

function validateAssertion(context, step) {
  if (!assertions.has(step.assert)) {
    fail(`${context}: unknown assertion "${step.assert}"`);
  }
  requireOnlyFields(step, assertionFields[step.assert], context);

  if (step.assert === 'floatingTopControls') {
    if (step.includes != null) {
      requireStringArray(step.includes, `${context}.includes`);
    }
    if (step.equals != null) {
      requireStringArray(step.equals, `${context}.equals`);
    }
    if (!step.includes && !step.equals) {
      fail(`${context}: includes or equals must be provided`);
    }
  }

  if (step.assert === 'selectionToolbarVisible' && step.openMode != null && !['floating', 'sidePanel'].includes(step.openMode)) {
    fail(`${context}.openMode must be floating or sidePanel when provided`);
  }

  if (['embeddedProviderHeaderHidden', 'floatingProvider', 'floatingAuthHelper', 'providerReceivedPrompt', 'sidebarProviderReceivedPrompt', 'storageProvider', 'sidebarProvider'].includes(step.assert)) {
    requireProvider(step.provider, `${context}.provider`);
  }

  if (step.assert === 'floatingAuthHelper') {
    if (step.textIncludes != null && typeof step.textIncludes !== 'string') {
      fail(`${context}.textIncludes must be string when provided`);
    }
    if (step.buttonText != null && typeof step.buttonText !== 'string') {
      fail(`${context}.buttonText must be string when provided`);
    }
  }

  if (step.assert === 'askPanelVisible' && step.quoteIncludes != null && typeof step.quoteIncludes !== 'string') {
    fail(`${context}.quoteIncludes must be string when provided`);
  }

  if (step.assert === 'floatingProviderTabs') {
    if (step.activeProvider) {
      requireProvider(step.activeProvider, `${context}.activeProvider`);
    }
    if (step.position && step.position !== 'bottom') {
      fail(`${context}: unsupported provider tab position "${step.position}"`);
    }
    if (step.iconOnly != null && typeof step.iconOnly !== 'boolean') {
      fail(`${context}.iconOnly must be boolean when provided`);
    }
    if (step.providerTitles != null) {
      requireStringArray(step.providerTitles, `${context}.providerTitles`);
    }
  }

  if (step.assert === 'floatingReferenceQuestion') {
    requireString(step.includes, `${context}.includes`);
  }

  if (step.assert === 'sidebarProviderUrl') {
    requireString(step.includes, `${context}.includes`);
  }

  if (step.assert === 'floatingAutoSubmit') {
    if (typeof step.value !== 'boolean') {
      fail(`${context}.value must be boolean`);
    }
    if (step.minPromptLength != null && (!Number.isInteger(step.minPromptLength) || step.minPromptLength < 0)) {
      fail(`${context}.minPromptLength must be a non-negative integer when provided`);
    }
  }

  if (step.assert === 'providerReceivedPrompt' || step.assert === 'sidebarProviderReceivedPrompt') {
    if (step.includes != null && typeof step.includes !== 'string') {
      fail(`${context}.includes must be string when provided`);
    }
    if (step.excludes != null && typeof step.excludes !== 'string') {
      fail(`${context}.excludes must be string when provided`);
    }
    if (step.autoSubmit != null && typeof step.autoSubmit !== 'boolean') {
      fail(`${context}.autoSubmit must be boolean when provided`);
    }
    if (step.submitted != null && typeof step.submitted !== 'boolean') {
      fail(`${context}.submitted must be boolean when provided`);
    }
    if (step.minPromptLength != null && (!Number.isInteger(step.minPromptLength) || step.minPromptLength < 0)) {
      fail(`${context}.minPromptLength must be a non-negative integer when provided`);
    }
  }

  if (step.assert === 'sidebarProviderTabsOnly' && step.providers != null) {
    requireStringArray(step.providers, `${context}.providers`);
    for (const provider of step.providers) {
      if (!providers.has(provider)) {
        fail(`${context}.providers contains invalid provider "${provider}"`);
      }
    }
  }
}

function requireProvider(value, label) {
  requireString(value, label);
  if (!providers.has(value)) {
    fail(`${label}: invalid provider "${value}"`);
  }
}

function requireString(value, label) {
  if (!value || typeof value !== 'string') {
    fail(`${label} must be a non-empty string`);
  }
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail(`${label} must be a non-empty string array`);
  }
}

function requireOnlyFields(value, allowedFields, label) {
  const allowed = new Set(allowedFields || []);
  const unknownFields = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknownFields.length > 0) {
    fail(`${label}: unknown field(s): ${unknownFields.join(', ')}`);
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`cannot read JSON ${filePath}: ${error.message}`);
  }
}
