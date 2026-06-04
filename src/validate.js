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

function workflowRoleReferences(primary, participants) {
  const roles = new Set();
  if (typeof primary === 'string') {
    roles.add(primary);
  }
  if (Array.isArray(participants)) {
    participants.filter((participant) => typeof participant === 'string').forEach((participant) => roles.add(participant));
  }
  return roles;
}

function validateWorkflowStepRole({ entity, path, value, declaredRoles }) {
  if (typeof value !== 'string') {
    return [createDiagnostic({
      file: entity.file,
      path,
      message: 'expected role reference to be a string',
    })];
  }

  if (!declaredRoles.has(value)) {
    return [createDiagnostic({
      file: entity.file,
      path,
      message: `workflow step role "${value}" is not declared in roles.primary or roles.participants`,
    })];
  }

  return [];
}

function validateObjectWorkflowStep({ entity, index, stats, step, stepIndex, declaredRoles }) {
  const diagnostics = [];
  const fieldPath = `steps[${stepIndex}]`;

  if (Object.hasOwn(step, 'at')) {
    diagnostics.push(createDiagnostic({
      file: entity.file,
      path: `${fieldPath}.at`,
      message: 'workflow object steps must use "from"; field "at" is not supported',
    }));
  }

  if (!Object.hasOwn(step, 'capability')) {
    diagnostics.push(createDiagnostic({
      file: entity.file,
      path: `${fieldPath}.capability`,
      message: 'required field "capability" is missing',
    }));
  } else {
    diagnostics.push(...validateReference({
      entity,
      index,
      path: `${fieldPath}.capability`,
      value: step.capability,
      targetScope: 'capabilities',
      stats,
    }));
  }

  if (!Object.hasOwn(step, 'from')) {
    diagnostics.push(createDiagnostic({
      file: entity.file,
      path: `${fieldPath}.from`,
      message: 'required field "from" is missing',
    }));

    if (Object.hasOwn(step, 'to')) {
      diagnostics.push(createDiagnostic({
        file: entity.file,
        path: `${fieldPath}.to`,
        message: 'field "to" requires field "from"',
      }));
    }
  } else {
    diagnostics.push(...validateWorkflowStepRole({
      entity,
      path: `${fieldPath}.from`,
      value: step.from,
      declaredRoles,
    }));
  }

  if (Object.hasOwn(step, 'to') && Object.hasOwn(step, 'from')) {
    diagnostics.push(...validateWorkflowStepRole({
      entity,
      path: `${fieldPath}.to`,
      value: step.to,
      declaredRoles,
    }));
  }

  diagnostics.push(...validateOptionalString({
    entity,
    path: `${fieldPath}.label`,
    value: step.label,
    message: 'expected label to be a string',
  }));

  return diagnostics;
}

function validateWorkflow(entity, index, stats) {
  const diagnostics = [];
  const rolesPrimary = getValueAtPath(entity.document, ['roles', 'primary']);
  const rolesParticipants = getValueAtPath(entity.document, ['roles', 'participants']);
  const triggeredBy = getValueAtPath(entity.document, ['triggered_by']);
  const declaredRoles = workflowRoleReferences(rolesPrimary, rolesParticipants);

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
        diagnostics.push(...validateObjectWorkflowStep({ entity, index, stats, step, stepIndex, declaredRoles }));
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

function validateCapabilityUses(entity, index, stats) {
  const diagnostics = [];
  const uses = getValueAtPath(entity.document, ['uses']);

  diagnostics.push(...validateOptionalArray({
    entity,
    path: 'uses',
    value: uses,
    message: 'expected an array of capability references',
  }));

  if (!Array.isArray(uses)) {
    return diagnostics;
  }

  const seen = new Map();
  uses.forEach((usedCapability, useIndex) => {
    const usePath = `uses[${useIndex}]`;
    diagnostics.push(...validateReference({
      entity,
      index,
      path: usePath,
      value: usedCapability,
      targetScope: 'capabilities',
      stats,
    }));

    if (typeof usedCapability !== 'string') {
      return;
    }

    if (usedCapability === entity.identity) {
      diagnostics.push(createDiagnostic({
        file: entity.file,
        path: usePath,
        message: `capability must not directly use itself: "${usedCapability}"`,
      }));
    }

    if (seen.has(usedCapability)) {
      diagnostics.push(createDiagnostic({
        severity: 'warning',
        file: entity.file,
        path: usePath,
        message: `duplicate capability use "${usedCapability}"; Capability.uses is ordered, but duplicate direct uses are likely accidental`,
      }));
      return;
    }

    seen.set(usedCapability, useIndex);
  });

  return diagnostics;
}

function validateCapability(entity, index, stats) {
  const diagnostics = validateCapabilityUses(entity, index, stats);
  const fields = [
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


function getCapabilityUsesGraph(entities, index) {
  const capabilityIndex = index.get('capabilities') ?? new Map();
  const graph = new Map();

  for (const entity of entities) {
    if (entity.scope !== 'capabilities' || !isPlainObject(entity.document)) {
      continue;
    }

    const uses = getValueAtPath(entity.document, ['uses']);
    if (!Array.isArray(uses)) {
      graph.set(entity.identity, []);
      continue;
    }

    const usableReferences = uses.filter((usedCapability) => (
      typeof usedCapability === 'string'
      && usedCapability !== entity.identity
      && capabilityIndex.has(usedCapability)
    ));
    graph.set(entity.identity, [...new Set(usableReferences)]);
  }

  return graph;
}

function canonicalCycleKey(cycleNodes) {
  const rotations = cycleNodes.map((_, index) => [
    ...cycleNodes.slice(index),
    ...cycleNodes.slice(0, index),
  ].join('\u0000'));
  return rotations.sort()[0];
}

function validateCapabilityUsesCycles(entities, index) {
  const diagnostics = [];
  const graph = getCapabilityUsesGraph(entities, index);
  const capabilityIndex = index.get('capabilities') ?? new Map();
  const state = new Map();
  const stack = [];
  const stackPositions = new Map();
  const emittedCycles = new Set();

  function visit(identity) {
    state.set(identity, 'visiting');
    stackPositions.set(identity, stack.length);
    stack.push(identity);

    for (const nextIdentity of graph.get(identity) ?? []) {
      if (!graph.has(nextIdentity)) {
        continue;
      }

      if (state.get(nextIdentity) === 'visiting') {
        const cycleNodes = stack.slice(stackPositions.get(nextIdentity));
        const cycleKey = canonicalCycleKey(cycleNodes);
        if (!emittedCycles.has(cycleKey)) {
          emittedCycles.add(cycleKey);
          const cyclePath = [...cycleNodes, nextIdentity].join(' -> ');
          const cycleStart = capabilityIndex.get(cycleNodes[0]);
          diagnostics.push(createDiagnostic({
            severity: 'warning',
            file: cycleStart?.file ?? '',
            path: 'uses',
            message: `capability uses cycle detected: ${cyclePath}`,
          }));
        }
        continue;
      }

      if (state.get(nextIdentity) !== 'visited') {
        visit(nextIdentity);
      }
    }

    stack.pop();
    stackPositions.delete(identity);
    state.set(identity, 'visited');
  }

  for (const identity of graph.keys()) {
    if (!state.has(identity)) {
      visit(identity);
    }
  }

  return diagnostics;
}

function workflowStepCapability(step) {
  if (typeof step === 'string') {
    return step;
  }

  if (isPlainObject(step) && typeof step.capability === 'string') {
    return step.capability;
  }

  return undefined;
}

function workflowStepCapabilityPath(step, stepIndex) {
  return isPlainObject(step) ? `steps[${stepIndex}].capability` : `steps[${stepIndex}]`;
}

function createCapabilityReachability(graph) {
  const cache = new Map();

  function reachableFrom(identity) {
    if (cache.has(identity)) {
      return cache.get(identity);
    }

    const reachable = new Set();
    cache.set(identity, reachable);

    function visit(current) {
      for (const next of graph.get(current) ?? []) {
        if (reachable.has(next)) {
          continue;
        }
        reachable.add(next);
        visit(next);
      }
    }

    visit(identity);
    return reachable;
  }

  return (source, target) => reachableFrom(source).has(target);
}

function validateWorkflowCapabilityDecompositionOverlap(entities, index) {
  const diagnostics = [];
  const graph = getCapabilityUsesGraph(entities, index);
  const reaches = createCapabilityReachability(graph);
  const capabilityIndex = index.get('capabilities') ?? new Map();

  for (const entity of entities) {
    if (entity.scope !== 'workflows' || !isPlainObject(entity.document)) {
      continue;
    }

    const steps = getValueAtPath(entity.document, ['steps']);
    if (!Array.isArray(steps)) {
      continue;
    }

    const capabilitySteps = steps
      .map((step, stepIndex) => ({
        identity: workflowStepCapability(step),
        path: workflowStepCapabilityPath(step, stepIndex),
      }))
      .filter(({ identity }) => typeof identity === 'string' && capabilityIndex.has(identity));

    for (let leftIndex = 0; leftIndex < capabilitySteps.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < capabilitySteps.length; rightIndex += 1) {
        const left = capabilitySteps[leftIndex];
        const right = capabilitySteps[rightIndex];
        if (left.identity === right.identity) {
          continue;
        }

        if (reaches(left.identity, right.identity)) {
          diagnostics.push(createDiagnostic({
            severity: 'warning',
            file: entity.file,
            path: right.path,
            message: `workflow step capability "${right.identity}" is also internal decomposition of step capability "${left.identity}"`,
          }));
        } else if (reaches(right.identity, left.identity)) {
          diagnostics.push(createDiagnostic({
            severity: 'warning',
            file: entity.file,
            path: right.path,
            message: `workflow step capability "${left.identity}" is also internal decomposition of step capability "${right.identity}"`,
          }));
        }
      }
    }
  }

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

  diagnostics.push(...validateCapabilityUsesCycles(loadedModel.entities, loadedModel.index));
  diagnostics.push(...validateWorkflowCapabilityDecompositionOverlap(loadedModel.entities, loadedModel.index));

  return {
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    diagnostics,
    entities: loadedModel.entities,
    index: loadedModel.index,
    summary: createValidationSummary(loadedModel.index, stats),
    coverage: createCoverage(loadedModel.entities, loadedModel.index),
  };
}
