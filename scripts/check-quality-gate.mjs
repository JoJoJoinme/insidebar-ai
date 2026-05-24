import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const matrixPath = path.join(repoRoot, 'docs/verification-matrix.json');
const acceptanceSpecPath = path.join(repoRoot, 'tests/acceptance/spec.json');
const validStatuses = new Set(['covered', 'gap', 'exploratory']);
const validScenarioTiers = new Set(['extension-contract', 'provider-boundary', 'browser-env']);
const proofBuckets = ['deterministic', 'real_live', 'manual'];
const failures = [];

const matrix = readJson(matrixPath, 'verification matrix');
const acceptanceScenarioIds = readAcceptanceScenarioIds();

if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) {
  failures.push('matrix must be a JSON object');
} else {
  if (!Array.isArray(matrix.invariants) || matrix.invariants.length === 0) {
    failures.push('matrix.invariants must be a non-empty array');
  } else {
    validateInvariants(matrix.invariants);
  }
}

if (failures.length > 0) {
  console.error('quality gate failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`quality gate passed: ${matrix.invariants.length} invariant(s)`);

function validateInvariants(invariants) {
  const ids = new Set();

  for (const invariant of invariants) {
    const label = invariant && invariant.id ? invariant.id : '<missing-id>';

    requireString(invariant.id, `${label}.id`);
    requireString(invariant.title, `${label}.title`);
    requireString(invariant.user_task, `${label}.user_task`);
    requireString(invariant.risk, `${label}.risk`);
    requireString(invariant.notes, `${label}.notes`);

    if (ids.has(invariant.id)) {
      failures.push(`duplicate invariant id: ${invariant.id}`);
    }
    ids.add(invariant.id);

    if (!validStatuses.has(invariant.status)) {
      failures.push(`${label}.status must be one of: ${[...validStatuses].join(', ')}`);
    }

    if (!invariant.proof || typeof invariant.proof !== 'object' || Array.isArray(invariant.proof)) {
      failures.push(`${label}.proof must be an object`);
      continue;
    }

    const proofCount = proofBuckets.reduce((count, bucket) => {
      const entries = invariant.proof[bucket];
      if (!Array.isArray(entries)) {
        failures.push(`${label}.proof.${bucket} must be an array`);
        return count;
      }
      for (const [index, proof] of entries.entries()) {
        validateProof(label, bucket, index, proof);
      }
      return count + entries.length;
    }, 0);

    if (invariant.status === 'covered' && proofCount === 0) {
      failures.push(`${label} is covered but has no proof entries`);
    }

    if ((invariant.status === 'gap' || invariant.status === 'exploratory') && invariant.notes.trim().length < 12) {
      failures.push(`${label} is ${invariant.status} and must explain the remaining gap in notes`);
    }
  }
}

function validateProof(label, bucket, index, proof) {
  const proofLabel = `${label}.proof.${bucket}[${index}]`;

  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    failures.push(`${proofLabel} must be an object`);
    return;
  }

  requireString(proof.type, `${proofLabel}.type`);
  requireString(proof.ref, `${proofLabel}.ref`);
  requireString(proof.command, `${proofLabel}.command`);

  if (proof.type === 'acceptance') {
    if (!acceptanceScenarioIds.has(proof.ref)) {
      failures.push(`${proofLabel}.ref references missing acceptance scenario: ${proof.ref}`);
    }
    return;
  }

  if (proof.type === 'unit' || proof.type === 'file') {
    const filePath = path.join(repoRoot, proof.ref);
    if (!isInsideRepo(filePath) || !fs.existsSync(filePath)) {
      failures.push(`${proofLabel}.ref references missing file: ${proof.ref}`);
    }
  }
}

function readAcceptanceScenarioIds() {
  if (!fs.existsSync(acceptanceSpecPath)) {
    return new Set();
  }

  const specs = readJson(acceptanceSpecPath, 'acceptance spec');
  if (!Array.isArray(specs)) {
    failures.push('tests/acceptance/spec.json must be an array when referenced by the matrix');
    return new Set();
  }

  const ids = new Set();
  for (const [index, scenario] of specs.entries()) {
    const label = `tests/acceptance/spec.json[${index}]`;
    if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
      failures.push(`${label} must be an object`);
      continue;
    }

    requireString(scenario.id, `${label}.id`);
    requireString(scenario.tier, `${label}.tier`);
    requireString(scenario.journey, `${label}.journey`);
    requireString(scenario.mockContract, `${label}.mockContract`);
    requireString(scenario.realBoundary, `${label}.realBoundary`);

    if (scenario.tier && !validScenarioTiers.has(scenario.tier)) {
      failures.push(`${label}.tier must be one of: ${[...validScenarioTiers].join(', ')}`);
    }
    if (scenario.id) {
      ids.add(scenario.id);
    }
  }

  return ids;
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    failures.push(`${field} must be a non-empty string`);
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`quality gate failed: cannot read ${label} at ${path.relative(repoRoot, filePath)}`);
    console.error(error.message);
    process.exit(1);
  }
}

function isInsideRepo(filePath) {
  const relativePath = path.relative(repoRoot, filePath);
  return relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}
