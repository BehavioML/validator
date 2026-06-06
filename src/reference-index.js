import { getValueAtPath, isPlainObject, resolveReferenceTarget, resolveTypedReferenceTarget } from './references.js';

function entityRef(entity) {
  return {
    scope: entity.scope,
    identity: entity.identity,
    file: entity.file,
  };
}

function byEntityRef(left, right) {
  return left.scope.localeCompare(right.scope)
    || left.identity.localeCompare(right.identity)
    || left.file.localeCompare(right.file);
}

function byReference(left, right) {
  return left.source.scope.localeCompare(right.source.scope)
    || left.source.identity.localeCompare(right.source.identity)
    || left.source.file.localeCompare(right.source.file)
    || left.fieldPath.localeCompare(right.fieldPath)
    || left.targetScope.localeCompare(right.targetScope)
    || left.targetIdentity.localeCompare(right.targetIdentity);
}

function byIncomingReference(left, right) {
  const leftTarget = left.target ?? { scope: left.targetScope, identity: left.targetIdentity, file: '' };
  const rightTarget = right.target ?? { scope: right.targetScope, identity: right.targetIdentity, file: '' };

  return byEntityRef(leftTarget, rightTarget) || byReference(left, right);
}

function makeReference({ source, fieldPath, targetScope, targetIdentity, target }) {
  const reference = {
    source: entityRef(source),
    fieldPath,
    targetScope,
    targetIdentity,
    resolved: Boolean(target),
  };

  if (target) {
    reference.target = entityRef(target);
  }

  return reference;
}

function addReference(references, { entity, index, fieldPath, value, targetScope }) {
  const resolved = resolveReferenceTarget({ index, targetScope, value });
  if (!resolved.reference) {
    return;
  }

  references.push(makeReference({
    source: entity,
    fieldPath,
    targetScope,
    targetIdentity: value,
    target: resolved.target,
  }));
}

function addArrayReferences(references, { entity, index, fieldPath, value, targetScope }) {
  if (!Array.isArray(value)) {
    return;
  }

  value.forEach((item, itemIndex) => {
    addReference(references, {
      entity,
      index,
      fieldPath: `${fieldPath}[${itemIndex}]`,
      value: item,
      targetScope,
    });
  });
}

function addScalarReference(references, { entity, index, fieldPath, value, targetScope }) {
  if (value === undefined) {
    return;
  }

  addReference(references, { entity, index, fieldPath, value, targetScope });
}

function addTypedReference(references, { entity, index, fieldPath, value }) {
  const resolved = resolveTypedReferenceTarget({ index, value });
  if (!resolved.reference) {
    return;
  }

  references.push(makeReference({
    source: entity,
    fieldPath,
    targetScope: resolved.targetScope,
    targetIdentity: resolved.targetIdentity,
    target: resolved.target,
  }));
}

function addWorkflowReferences(references, entity, index) {
  const rolesPrimary = getValueAtPath(entity.document, ['roles', 'primary']);
  const rolesParticipants = getValueAtPath(entity.document, ['roles', 'participants']);
  const triggeredBy = getValueAtPath(entity.document, ['triggered_by']);
  const steps = getValueAtPath(entity.document, ['steps']);

  addScalarReference(references, { entity, index, fieldPath: 'roles.primary', value: rolesPrimary, targetScope: 'roles' });
  addArrayReferences(references, { entity, index, fieldPath: 'roles.participants', value: rolesParticipants, targetScope: 'roles' });
  addArrayReferences(references, { entity, index, fieldPath: 'triggered_by', value: triggeredBy, targetScope: 'events' });

  if (!Array.isArray(steps)) {
    return;
  }

  steps.forEach((step, stepIndex) => {
    if (isPlainObject(step)) {
      if (Object.hasOwn(step, 'capability')) {
        addReference(references, {
          entity,
          index,
          fieldPath: `steps[${stepIndex}].capability`,
          value: step.capability,
          targetScope: 'capabilities',
        });
      }
    }
  });
}


function addSemanticAreaReferences(references, entity, index) {
  addArrayReferences(references, { entity, index, fieldPath: 'workflows', value: getValueAtPath(entity.document, ['workflows']), targetScope: 'workflows' });
}

function addCapabilityReferences(references, entity, index) {
  addArrayReferences(references, { entity, index, fieldPath: 'uses', value: getValueAtPath(entity.document, ['uses']), targetScope: 'capabilities' });
  addArrayReferences(references, { entity, index, fieldPath: 'requires', value: getValueAtPath(entity.document, ['requires']), targetScope: 'interfaces' });
  addArrayReferences(references, { entity, index, fieldPath: 'events', value: getValueAtPath(entity.document, ['events']), targetScope: 'events' });
}

function addComponentReferences(references, entity, index) {
  addArrayReferences(references, { entity, index, fieldPath: 'implements.capabilities', value: getValueAtPath(entity.document, ['implements', 'capabilities']), targetScope: 'capabilities' });
  addArrayReferences(references, { entity, index, fieldPath: 'implements.interfaces', value: getValueAtPath(entity.document, ['implements', 'interfaces']), targetScope: 'interfaces' });
  addScalarReference(references, { entity, index, fieldPath: 'belongs_to', value: getValueAtPath(entity.document, ['belongs_to']), targetScope: 'modules' });
}

function addStateMachineReferences(references, entity, index) {
  addScalarReference(references, { entity, index, fieldPath: 'entity', value: getValueAtPath(entity.document, ['entity']), targetScope: 'entities' });

  const transitions = getValueAtPath(entity.document, ['transitions']);
  if (!Array.isArray(transitions)) {
    return;
  }

  transitions.forEach((transition, transitionIndex) => {
    if (!isPlainObject(transition) || !Object.hasOwn(transition, 'on')) {
      return;
    }

    addReference(references, {
      entity,
      index,
      fieldPath: `transitions[${transitionIndex}].on`,
      value: transition.on,
      targetScope: 'events',
    });
  });
}

function addDecisionReferences(references, entity, index) {
  const affects = getValueAtPath(entity.document, ['affects']);
  if (!Array.isArray(affects)) {
    return;
  }

  affects.forEach((item, itemIndex) => {
    addTypedReference(references, {
      entity,
      index,
      fieldPath: `affects[${itemIndex}]`,
      value: item,
    });
  });
}

function addEntityReferences(references, entity, index) {
  if (!isPlainObject(entity.document)) {
    return;
  }

  switch (entity.scope) {
    case 'workflows':
      addWorkflowReferences(references, entity, index);
      return;
    case 'semantic-areas':
      addSemanticAreaReferences(references, entity, index);
      return;
    case 'capabilities':
      addCapabilityReferences(references, entity, index);
      return;
    case 'components':
      addComponentReferences(references, entity, index);
      return;
    case 'state-machines':
      addStateMachineReferences(references, entity, index);
      return;
    case 'decisions':
      addDecisionReferences(references, entity, index);
      return;
    default:
  }
}

export function createReferenceIndex(modelOrEntities, maybeIndex) {
  const entities = Array.isArray(modelOrEntities) ? modelOrEntities : modelOrEntities.entities;
  const index = maybeIndex ?? modelOrEntities.index;
  const entityRefs = entities
    .map(entityRef)
    .sort(byEntityRef);
  const outgoingReferences = [];

  for (const entity of entities) {
    addEntityReferences(outgoingReferences, entity, index);
  }

  outgoingReferences.sort(byReference);

  const incomingReferences = outgoingReferences
    .filter((reference) => reference.resolved)
    .toSorted(byIncomingReference);
  const unresolvedReferences = outgoingReferences
    .filter((reference) => !reference.resolved)
    .toSorted(byReference);

  return {
    entities: entityRefs,
    outgoingReferences,
    incomingReferences,
    unresolvedReferences,
  };
}

export function createEmptyReferenceIndex() {
  return {
    entities: [],
    outgoingReferences: [],
    incomingReferences: [],
    unresolvedReferences: [],
  };
}
