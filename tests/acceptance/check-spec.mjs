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
  'dockFloating'
]);

const assertions = new Set([
  'selectionToolbarVisible',
  'floatingVisible',
  'askPanelVisible',
  'floatingTopControls',
  'floatingProviderTabs',
  'embeddedChatgptHeaderHidden',
  'floatingProvider',
  'floatingReferenceQuestion',
  'floatingAutoSubmit',
  'storageProvider',
  'sidebarProvider',
  'sidebarProviderTabsOnly'
]);

const providers = new Set(['chatgpt', 'claude', 'gemini', 'google', 'grok', 'deepseek']);
const runners = new Set(['cft']);

function fail(message) {
  console.error(`acceptance spec failed: ${message}`);
  process.exit(1);
}

if (!Array.isArray(specs) || specs.length === 0) {
  fail('spec must be a non-empty array');
}

const ids = new Set();

for (const scenario of specs) {
  requireString(scenario.id, 'scenario.id');
  requireString(scenario.intent, `${scenario.id}.intent`);

  if (ids.has(scenario.id)) {
    fail(`duplicate scenario id: ${scenario.id}`);
  }
  ids.add(scenario.id);

  if (!runners.has(scenario.runner)) {
    fail(`${scenario.id}: unsupported runner "${scenario.runner}"`);
  }

  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    fail(`${scenario.id}: steps must be a non-empty array`);
  }

  validateSettings(scenario.id, scenario.settings || {});

  for (const [index, step] of scenario.steps.entries()) {
    const context = `${scenario.id}.steps[${index}]`;
    if (step.action) {
      validateAction(context, step);
    } else if (step.assert) {
      validateAssertion(context, step);
    } else {
      fail(`${context}: step must include action or assert`);
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

  if (step.action === 'submitAskQuestion') {
    requireString(step.question, `${context}.question`);
  }
}

function validateAssertion(context, step) {
  if (!assertions.has(step.assert)) {
    fail(`${context}: unknown assertion "${step.assert}"`);
  }

  if (step.assert === 'floatingTopControls') {
    if (!Array.isArray(step.includes) || step.includes.length === 0) {
      fail(`${context}: includes must be a non-empty array`);
    }
  }

  if (['floatingProvider', 'storageProvider', 'sidebarProvider'].includes(step.assert)) {
    requireProvider(step.provider, `${context}.provider`);
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
  }

  if (step.assert === 'floatingReferenceQuestion') {
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

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`cannot read JSON ${filePath}: ${error.message}`);
  }
}
