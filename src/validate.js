import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createDiagnostic } from './diagnostics.js';
import { loadModel } from './load-model.js';
import { RESERVED_TOP_LEVEL_FIELDS } from './rules.js';
import { createCoverage } from './coverage.js';
import { createReferenceStats, createValidationSummary } from './summary.js';
import { validateNonEmptyArray, validateOptionalArray, validateOptionalString, validateRequiredArray } from './shapes.js';
import {
  getValueAtPath,
  isPlainObject,
  validateArrayReferenceField,
  validateReference,
  validateScalarReferenceField,
  validateTypedReference,
} from './references.js';

async function directoryExists(modelDir) {
  try {
    const stats = await fs.stat(modelDir);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

function validateIdentity(entity) {
  if (!isPlainObject(entity.document)) {
    return [];
  }

  return RESERVED_TOP_LEVEL_FIELDS
    .filter((field) => Object.hasOwn(entity.document, field))
    .map((field) => createDiagnostic({
      file: entity.file,
      path: field,
      message: `top-level field "${field}" is not supported; identity is derived from the file path`,
    }));
}

function validateWorkflow(entity, index, stats) {
  const diagnostics = [];
  const rolesPrimary = getValueAtPath(entity.document, ['roles', 'primary']);
  const rolesParticipants = getValueAtPath(entity.document, ['roles', 'participants']);
  const triggeredBy = getValueAtPath(entity.document, ['triggered_by']);

  diagnostics.push(
    ...validateOptionalString({ entity, path: 'roles.primary', value: rolesPrimary, message: 'expected a role reference string' }),
    ...validateOptionalArray({ entity, path: 'roles.participants', value: rolesParticipants, message: 'expected an array of role references' }),
    ...validateOptionalArray({ entity, path: 'triggered_by', value: triggeredBy, message: 'expected an array of event references' }),
  );

  if (typeof rolesPrimary === 'string') {
    diagnostics.push(...validateScalarReferenceField({ entity, index, fieldPath: 'roles.primary', pathSegments: ['roles', 'primary'], targetScope: 'roles', stats }));
  }
  if (Array.isArray(rolesParticipants)) {
    diagnostics.push(...validateArrayReferenceField({ entity, index, fieldPath: 'roles.participants', pathSegments: ['roles', 'participants'], targetScope: 'roles', stats }));
  }
  if (Array.isArray(triggeredBy)) {
    diagnostics.push(...validateArrayReferenceField({ entity, index, fieldPath: 'triggered_by', pathSegments: ['triggered_by'], targetScope: 'events', stats }));
  }

  for (const componentField of ['component', 'components']) {
    if (Object.hasOwn(entity.document, componentField)) {
      diagnostics.push(createDiagnostic({
        file: entity.file,
        path: componentField,
        message: 'workflows must not reference components directly',
      }));
    }
  }

  const steps = getValueAtPath(entity.document, ['steps']);
  diagnostics.push(...validateRequiredArray({
    entity,
    path: 'steps',
    value: steps,
    missingMessage: 'required field "steps" is missing',
    invalidMessage: 'expected a non-empty array of capability references',
  }));

  if (Array.isArray(steps)) {
    diagnostics.push(...validateNonEmptyArray({
      entity,
      path: 'steps',
      value: steps,
      message: 'expected a non-empty array of capability references',
    }));

    steps.forEach((step, stepIndex) => {
      const fieldPath = `steps[${stepIndex}]`;
      if (isPlainObject(step)) {
        diagnostics.push(createDiagnostic({
          file: entity.file,
          path: fieldPath,
          message: 'object workflow steps are experimental and unsupported by this validator',
        }));
        return;
      }

      diagnostics.push(...validateReference({
        entity,
        index,
        path: fieldPath,
        value: step,
        targetScope: 'capabilities',
        stats,
      }));
    });
  }

  return diagnostics;
}

function validateCapability(entity, index, stats) {
  const diagnostics = [];
  const fields = [
    { fieldPath: 'uses', pathSegments: ['uses'], targetScope: 'capabilities', message: 'expected an array of capability references' },
    { fieldPath: 'requires', pathSegments: ['requires'], targetScope: 'interfaces', message: 'expected an array of interface references' },
    { fieldPath: 'events', pathSegments: ['events'], targetScope: 'events', message: 'expected an array of event references' },
  ];

  for (const field of fields) {
    const value = getValueAtPath(entity.document, field.pathSegments);
    diagnostics.push(...validateOptionalArray({ entity, path: field.fieldPath, value, message: field.message }));
    if (Array.isArray(value)) {
      diagnostics.push(...validateArrayReferenceField({ entity, index, ...field, stats }));
    }
  }

  return diagnostics;
}

function validateComponent(entity, index, stats) {
  const diagnostics = [];
  const implementsCapabilities = getValueAtPath(entity.document, ['implements', 'capabilities']);
  const implementsInterfaces = getValueAtPath(entity.document, ['implements', 'interfaces']);
  const belongsTo = getValueAtPath(entity.document, ['belongs_to']);

  diagnostics.push(
    ...validateOptionalArray({ entity, path: 'implements.capabilities', value: implementsCapabilities, message: 'expected an array of capability references' }),
    ...validateOptionalArray({ entity, path: 'implements.interfaces', value: implementsInterfaces, message: 'expected an array of interface references' }),
    ...validateOptionalString({ entity, path: 'belongs_to', value: belongsTo, message: 'expected a module reference string' }),
  );

  if (Array.isArray(implementsCapabilities)) {
    diagnostics.push(...validateArrayReferenceField({ entity, index, fieldPath: 'implements.capabilities', pathSegments: ['implements', 'capabilities'], targetScope: 'capabilities', stats }));
  }
  if (Array.isArray(implementsInterfaces)) {
    diagnostics.push(...validateArrayReferenceField({ entity, index, fieldPath: 'implements.interfaces', pathSegments: ['implements', 'interfaces'], targetScope: 'interfaces', stats }));
  }
  if (typeof belongsTo === 'string') {
    diagnostics.push(...validateScalarReferenceField({ entity, index, fieldPath: 'belongs_to', pathSegments: ['belongs_to'], targetScope: 'modules', stats }));
  }

  return diagnostics;
}

function validateTransitionStateReference({ entity, path, value, declaredStates }) {
  if (typeof value === 'string') {
    if (declaredStates && !declaredStates.has(value)) {
      return [createDiagnostic({
        file: entity.file,
        path,
        message: `state "${value}" is not declared in states`,
      })];
    }
    return [];
  }

  return [createDiagnostic({
    file: entity.file,
    path,
    message: 'expected transition state to be a string',
  })];
}

function validateTransitionFrom({ entity, path, value, declaredStates }) {
  if (Array.isArray(value)) {
    const diagnostics = validateNonEmptyArray({
      entity,
      path,
      value,
      message: 'expected transition from state to be a string or non-empty array of strings',
    });

    value.forEach((state, stateIndex) => {
      diagnostics.push(...validateTransitionStateReference({
        entity,
        path: `${path}[${stateIndex}]`,
        value: state,
        declaredStates,
      }));
    });

    return diagnostics;
  }

  if (typeof value === 'string') {
    return validateTransitionStateReference({ entity, path, value, declaredStates });
  }

  return [createDiagnostic({
    file: entity.file,
    path,
    message: 'expected transition from state to be a string or non-empty array of strings',
  })];
}

function validateTransitionTo({ entity, path, value, declaredStates }) {
  if (typeof value !== 'string') {
    return [createDiagnostic({
      file: entity.file,
      path,
      message: 'expected transition to state to be a string',
    })];
  }

  return validateTransitionStateReference({ entity, path, value, declaredStates });
}

function validateStateMachine(entity, index, stats) {
  const diagnostics = [
    ...validateScalarReferenceField({ entity, index, fieldPath: 'entity', pathSegments: ['entity'], targetScope: 'entities', stats }),
  ];
  const states = getValueAtPath(entity.document, ['states']);
  const transitions = getValueAtPath(entity.document, ['transitions']);
  const declaredStates = Array.isArray(states)
    ? new Set(states.filter((state) => typeof state === 'string'))
    : undefined;

  diagnostics.push(
    ...validateOptionalArray({ entity, path: 'states', value: states, message: 'expected an array of state names' }),
    ...validateOptionalArray({ entity, path: 'transitions', value: transitions, message: 'expected an array of transitions' }),
  );

  if (Array.isArray(states)) {
    states.forEach((state, stateIndex) => {
      diagnostics.push(...validateOptionalString({
        entity,
        path: `states[${stateIndex}]`,
        value: state,
        message: 'expected state name to be a string',
      }));
    });
  }

  if (Array.isArray(transitions)) {
    transitions.forEach((transition, transitionIndex) => {
      if (!isPlainObject(transition)) {
        diagnostics.push(createDiagnostic({
          file: entity.file,
          path: `transitions[${transitionIndex}]`,
          message: 'expected transition to be an object',
        }));
        return;
      }

      if (Object.hasOwn(transition, 'from')) {
        diagnostics.push(...validateTransitionFrom({
          entity,
          path: `transitions[${transitionIndex}].from`,
          value: transition.from,
          declaredStates,
        }));
      }

      if (Object.hasOwn(transition, 'to')) {
        diagnostics.push(...validateTransitionTo({
          entity,
          path: `transitions[${transitionIndex}].to`,
          value: transition.to,
          declaredStates,
        }));
      }

      if (Object.hasOwn(transition, 'on')) {
        diagnostics.push(...validateReference({
          entity,
          index,
          path: `transitions[${transitionIndex}].on`,
          value: transition.on,
          targetScope: 'events',
          stats,
        }));
      }
    });
  }

  return diagnostics;
}

function validateDecision(entity, index, stats) {
  const affects = getValueAtPath(entity.document, ['affects']);
  if (affects === undefined) {
    return [];
  }

  if (!Array.isArray(affects)) {
    return [createDiagnostic({
      file: entity.file,
      path: 'affects',
      message: 'expected a non-empty array of typed references',
    })];
  }

  const diagnostics = validateNonEmptyArray({
    entity,
    path: 'affects',
    value: affects,
    message: 'expected a non-empty array of typed references',
  });

  diagnostics.push(...affects.flatMap((item, itemIndex) => validateTypedReference({
    entity,
    index,
    path: `affects[${itemIndex}]`,
    value: item,
    stats,
  })));

  return diagnostics;
}

function validateEntityReferences(entity, index, stats) {
  if (!isPlainObject(entity.document)) {
    return [];
  }

  switch (entity.scope) {
    case 'workflows':
      return validateWorkflow(entity, index, stats);
    case 'capabilities':
      return validateCapability(entity, index, stats);
    case 'components':
      return validateComponent(entity, index, stats);
    case 'state-machines':
      return validateStateMachine(entity, index, stats);
    case 'decisions':
      return validateDecision(entity, index, stats);
    default:
      return [];
  }
}

export async function validateModel(modelDir) {
  const absoluteModelDir = path.resolve(modelDir);
  if (!await directoryExists(absoluteModelDir)) {
    return {
      valid: false,
      diagnostics: [createDiagnostic({
        file: path.basename(modelDir) || modelDir,
        message: `model directory does not exist: ${modelDir}`,
      })],
      entities: [],
      index: new Map(),
      summary: createValidationSummary(new Map(), createReferenceStats()),
      coverage: createCoverage([], new Map()),
    };
  }

  const loadedModel = await loadModel(absoluteModelDir);
  const stats = createReferenceStats();
  const diagnostics = [...loadedModel.diagnostics];

  for (const entity of loadedModel.entities) {
    diagnostics.push(...validateIdentity(entity));
  }

  for (const entity of loadedModel.entities) {
    diagnostics.push(...validateEntityReferences(entity, loadedModel.index, stats));
  }

  return {
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    diagnostics,
    entities: loadedModel.entities,
    index: loadedModel.index,
    summary: createValidationSummary(loadedModel.index, stats),
    coverage: createCoverage(loadedModel.entities, loadedModel.index),
  };
}
