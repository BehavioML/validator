import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createDiagnostic } from './diagnostics.js';
import { loadModel } from './load-model.js';
import { RESERVED_TOP_LEVEL_FIELDS } from './rules.js';
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

function validateWorkflow(entity, index) {
  const diagnostics = [
    ...validateScalarReferenceField({ entity, index, fieldPath: 'roles.primary', pathSegments: ['roles', 'primary'], targetScope: 'roles' }),
    ...validateArrayReferenceField({ entity, index, fieldPath: 'roles.participants', pathSegments: ['roles', 'participants'], targetScope: 'roles' }),
    ...validateArrayReferenceField({ entity, index, fieldPath: 'triggered_by', pathSegments: ['triggered_by'], targetScope: 'events' }),
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
        }));
      });
    }
  }

  return diagnostics;
}

function validateCapability(entity, index) {
  return [
    ...validateArrayReferenceField({ entity, index, fieldPath: 'uses', pathSegments: ['uses'], targetScope: 'capabilities' }),
    ...validateArrayReferenceField({ entity, index, fieldPath: 'requires', pathSegments: ['requires'], targetScope: 'interfaces' }),
    ...validateArrayReferenceField({ entity, index, fieldPath: 'events', pathSegments: ['events'], targetScope: 'events' }),
  ];
}

function validateComponent(entity, index) {
  return [
    ...validateArrayReferenceField({ entity, index, fieldPath: 'implements.capabilities', pathSegments: ['implements', 'capabilities'], targetScope: 'capabilities' }),
    ...validateArrayReferenceField({ entity, index, fieldPath: 'implements.interfaces', pathSegments: ['implements', 'interfaces'], targetScope: 'interfaces' }),
    ...validateScalarReferenceField({ entity, index, fieldPath: 'belongs_to', pathSegments: ['belongs_to'], targetScope: 'modules' }),
  ];
}

function validateStateMachine(entity, index) {
  const diagnostics = [
    ...validateScalarReferenceField({ entity, index, fieldPath: 'entity', pathSegments: ['entity'], targetScope: 'entities' }),
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
          }));
        }
      });
    }
  }

  return diagnostics;
}

function validateDecision(entity, index) {
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
  }));
}

function validateEntityReferences(entity, index) {
  if (!isPlainObject(entity.document)) {
    return [];
  }

  switch (entity.scope) {
    case 'workflows':
      return validateWorkflow(entity, index);
    case 'capabilities':
      return validateCapability(entity, index);
    case 'components':
      return validateComponent(entity, index);
    case 'state-machines':
      return validateStateMachine(entity, index);
    case 'decisions':
      return validateDecision(entity, index);
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
    };
  }

  const loadedModel = await loadModel(absoluteModelDir);
  const diagnostics = [...loadedModel.diagnostics];

  for (const entity of loadedModel.entities) {
    diagnostics.push(...validateIdentity(entity));
  }

  for (const entity of loadedModel.entities) {
    diagnostics.push(...validateEntityReferences(entity, loadedModel.index));
  }

  return {
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    diagnostics,
    entities: loadedModel.entities,
    index: loadedModel.index,
  };
}
