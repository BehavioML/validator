import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createDiagnostic } from './diagnostics.js';
import { loadModel } from './load-model.js';
import { RESERVED_TOP_LEVEL_FIELDS } from './rules.js';
import { createReferenceStats, createValidationSummary } from './summary.js';
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
  const diagnostics = [
    ...validateScalarReferenceField({ entity, index, fieldPath: 'roles.primary', pathSegments: ['roles', 'primary'], targetScope: 'roles', stats }),
    ...validateArrayReferenceField({ entity, index, fieldPath: 'roles.participants', pathSegments: ['roles', 'participants'], targetScope: 'roles', stats }),
    ...validateArrayReferenceField({ entity, index, fieldPath: 'triggered_by', pathSegments: ['triggered_by'], targetScope: 'events', stats }),
  ];

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
  if (steps !== undefined) {
    if (!Array.isArray(steps)) {
      diagnostics.push(createDiagnostic({
        file: entity.file,
        path: 'steps',
        message: 'expected an array of capability references',
      }));
    } else {
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
  }

  return diagnostics;
}

function validateCapability(entity, index, stats) {
  return [
    ...validateArrayReferenceField({ entity, index, fieldPath: 'uses', pathSegments: ['uses'], targetScope: 'capabilities', stats }),
    ...validateArrayReferenceField({ entity, index, fieldPath: 'requires', pathSegments: ['requires'], targetScope: 'interfaces', stats }),
    ...validateArrayReferenceField({ entity, index, fieldPath: 'events', pathSegments: ['events'], targetScope: 'events', stats }),
  ];
}

function validateComponent(entity, index, stats) {
  return [
    ...validateArrayReferenceField({ entity, index, fieldPath: 'implements.capabilities', pathSegments: ['implements', 'capabilities'], targetScope: 'capabilities', stats }),
    ...validateArrayReferenceField({ entity, index, fieldPath: 'implements.interfaces', pathSegments: ['implements', 'interfaces'], targetScope: 'interfaces', stats }),
    ...validateScalarReferenceField({ entity, index, fieldPath: 'belongs_to', pathSegments: ['belongs_to'], targetScope: 'modules', stats }),
  ];
}

function validateStateMachine(entity, index, stats) {
  const diagnostics = [
    ...validateScalarReferenceField({ entity, index, fieldPath: 'entity', pathSegments: ['entity'], targetScope: 'entities', stats }),
  ];
  const transitions = getValueAtPath(entity.document, ['transitions']);

  if (transitions !== undefined) {
    if (!Array.isArray(transitions)) {
      diagnostics.push(createDiagnostic({
        file: entity.file,
        path: 'transitions',
        message: 'expected an array of transitions',
      }));
    } else {
      transitions.forEach((transition, transitionIndex) => {
        if (!isPlainObject(transition)) {
          diagnostics.push(createDiagnostic({
            file: entity.file,
            path: `transitions[${transitionIndex}]`,
            message: 'expected transition to be an object',
          }));
          return;
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
      message: 'expected an array of typed references',
    })];
  }

  return affects.flatMap((item, itemIndex) => validateTypedReference({
    entity,
    index,
    path: `affects[${itemIndex}]`,
    value: item,
    stats,
  }));
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
  };
}
