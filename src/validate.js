import path from 'node:path';
import { createDiagnostic } from './diagnostics.js';
import { loadModel } from './load-model.js';
import { FilesystemWorkspace } from './workspace.js';
import { RESERVED_TOP_LEVEL_FIELDS } from './rules.js';
import { createCoverage } from './coverage.js';
import { createEmptyReferenceIndex } from './reference-index.js';
import { createReferenceStats, createValidationSummary } from './summary.js';
import { validateNonEmptyArray, validateOptionalArray, validateOptionalString, validateRequiredArray } from './shapes.js';
import {
  getValueAtPath,
  isPlainObject,
  isRelativeReference,
  validateArrayReferenceField,
  validateReference,
  validateScalarReferenceField,
  validateTypedReference,
} from './references.js';

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

function validateRequiredNonEmptyString({ entity, path, value, fieldName }) {
  if (isNonEmptyString(value)) {
    return [];
  }

  return [createDiagnostic({
    file: entity.file,
    path,
    message: `required field "${fieldName}" must be a non-empty string`,
  })];
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

const WORKFLOW_EVENT_EMISSION_FIELDS = Object.freeze(['emits', 'may_emit', 'observes', 'outcomes', 'success', 'failure']);
const WORKFLOW_CAPABILITY_STEP_ALLOWED_FIELDS = new Set(['from', 'to', 'capability', 'label']);
const WORKFLOW_REFERENCE_STEP_ALLOWED_FIELDS = new Set(['workflow', 'bind', 'from', 'to', 'capability', 'label']);
const WORKFLOW_STEP_FORBIDDEN_FIELDS = new Set(['at', 'action', 'event', 'emits', 'uses']);
const WORKFLOW_REFERENCE_STEP_CAPABILITY_FIELDS = new Set(['from', 'to', 'capability', 'label']);

function normalizeWorkflowReference(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  return value.startsWith('workflows/') ? value.slice('workflows/'.length) : value;
}

function resolveWorkflowReferenceTarget({ index, value }) {
  const normalized = normalizeWorkflowReference(value);
  if (normalized === undefined || isRelativeReference(normalized)) {
    return { reference: false };
  }

  return {
    reference: true,
    targetIdentity: normalized,
    target: index.get('workflows')?.get(normalized),
  };
}

function validateWorkflowReference({ entity, index, path, value, stats }) {
  if (typeof value !== 'string') {
    return [createDiagnostic({
      file: entity.file,
      path,
      message: 'expected workflow reference to be a string',
    })];
  }

  const normalized = normalizeWorkflowReference(value);
  if (isRelativeReference(normalized)) {
    return [createDiagnostic({
      file: entity.file,
      path,
      message: `workflow reference "${value}" must be a path identity, not a filesystem-relative reference`,
    })];
  }

  const resolved = resolveWorkflowReferenceTarget({ index, value });
  stats.references.checked += 1;

  if (!resolved.target) {
    stats.references.missing += 1;
    return [createDiagnostic({
      file: entity.file,
      path,
      message: `missing workflow "${value}"`,
    })];
  }

  return [];
}

function validateWorkflowStepFields({ entity, step, fieldPath, allowedFields, variantDescription }) {
  const diagnostics = [];

  for (const field of Object.keys(step)) {
    if (allowedFields.has(field)) {
      continue;
    }

    diagnostics.push(createDiagnostic({
      file: entity.file,
      path: `${fieldPath}.${field}`,
      message: WORKFLOW_STEP_FORBIDDEN_FIELDS.has(field)
        ? `workflow steps do not support field "${field}"; ${variantDescription}`
        : `unknown workflow step field "${field}"; ${variantDescription}`,
    }));
  }

  return diagnostics;
}

function validateObjectWorkflowStep({ entity, index, stats, step, stepIndex, declaredRoles }) {
  const diagnostics = [];
  const fieldPath = `steps[${stepIndex}]`;

  diagnostics.push(...validateWorkflowStepFields({
    entity,
    step,
    fieldPath,
    allowedFields: WORKFLOW_CAPABILITY_STEP_ALLOWED_FIELDS,
    variantDescription: 'use explicit "from", optional "to", "capability", and "label" fields',
  }));

  for (const requiredField of ['from', 'capability', 'label']) {
    if (!Object.hasOwn(step, requiredField)) {
      diagnostics.push(createDiagnostic({
        file: entity.file,
        path: `${fieldPath}.${requiredField}`,
        message: `required field "${requiredField}" is missing`,
      }));
    }
  }

  if (Object.hasOwn(step, 'capability')) {
    diagnostics.push(...validateRequiredNonEmptyString({
      entity,
      path: `${fieldPath}.capability`,
      value: step.capability,
      fieldName: 'capability',
    }));

    if (isNonEmptyString(step.capability)) {
      diagnostics.push(...validateReference({
        entity,
        index,
        path: `${fieldPath}.capability`,
        value: step.capability,
        targetScope: 'capabilities',
        stats,
      }));
    }
  }

  if (!Object.hasOwn(step, 'from')) {
    if (Object.hasOwn(step, 'to')) {
      diagnostics.push(createDiagnostic({
        file: entity.file,
        path: `${fieldPath}.to`,
        message: 'field "to" requires field "from"',
      }));
    }
  } else {
    diagnostics.push(...validateRequiredNonEmptyString({
      entity,
      path: `${fieldPath}.from`,
      value: step.from,
      fieldName: 'from',
    }));

    if (isNonEmptyString(step.from)) {
      diagnostics.push(...validateWorkflowStepRole({
        entity,
        path: `${fieldPath}.from`,
        value: step.from,
        declaredRoles,
      }));
    }
  }

  if (Object.hasOwn(step, 'to') && Object.hasOwn(step, 'from')) {
    diagnostics.push(...validateRequiredNonEmptyString({
      entity,
      path: `${fieldPath}.to`,
      value: step.to,
      fieldName: 'to',
    }));

    if (isNonEmptyString(step.to)) {
      diagnostics.push(...validateWorkflowStepRole({
        entity,
        path: `${fieldPath}.to`,
        value: step.to,
        declaredRoles,
      }));
    }
  }

  if (Object.hasOwn(step, 'label')) {
    diagnostics.push(...validateRequiredNonEmptyString({
      entity,
      path: `${fieldPath}.label`,
      value: step.label,
      fieldName: 'label',
    }));
  }

  return diagnostics;
}


function childWorkflowRoles(childWorkflow) {
  const rolesPrimary = getValueAtPath(childWorkflow.document, ['roles', 'primary']);
  const rolesParticipants = getValueAtPath(childWorkflow.document, ['roles', 'participants']);
  const roles = workflowRoleReferences(rolesPrimary, rolesParticipants);
  const steps = getValueAtPath(childWorkflow.document, ['steps']);

  if (Array.isArray(steps)) {
    for (const step of steps) {
      if (!isPlainObject(step) || Object.hasOwn(step, 'workflow')) {
        continue;
      }
      if (typeof step.from === 'string') {
        roles.add(step.from);
      }
      if (typeof step.to === 'string') {
        roles.add(step.to);
      }
    }
  }

  return roles;
}

function validateWorkflowReferenceBind({ entity, index, step, fieldPath, declaredRoles }) {
  const diagnostics = [];

  if (!Object.hasOwn(step, 'bind')) {
    return [createDiagnostic({
      file: entity.file,
      path: `${fieldPath}.bind`,
      message: 'required field "bind" is missing',
    })];
  }

  if (!isPlainObject(step.bind)) {
    return [createDiagnostic({
      file: entity.file,
      path: `${fieldPath}.bind`,
      message: 'workflow reference step bind must be a non-empty mapping/object',
    })];
  }

  const bindEntries = Object.entries(step.bind);
  if (bindEntries.length === 0) {
    return [createDiagnostic({
      file: entity.file,
      path: `${fieldPath}.bind`,
      message: 'workflow reference step bind must be a non-empty mapping/object',
    })];
  }

  const resolved = resolveWorkflowReferenceTarget({ index, value: step.workflow });
  const childWorkflow = resolved.target;
  const childRoles = childWorkflow ? childWorkflowRoles(childWorkflow) : undefined;

  for (const [childRole, parentRole] of bindEntries) {
    if (childRoles && !childRoles.has(childRole)) {
      diagnostics.push(createDiagnostic({
        file: entity.file,
        path: `${fieldPath}.bind.${childRole}`,
        message: `bind key "${childRole}" is not a role used by workflow "${step.workflow}"`,
      }));
    }

    if (!isNonEmptyString(parentRole)) {
      diagnostics.push(createDiagnostic({
        file: entity.file,
        path: `${fieldPath}.bind.${childRole}`,
        message: 'workflow reference bind values must be non-empty strings',
      }));
      continue;
    }

    if (declaredRoles.size > 0 && !declaredRoles.has(parentRole)) {
      diagnostics.push(createDiagnostic({
        file: entity.file,
        path: `${fieldPath}.bind.${childRole}`,
        message: `bind target role "${parentRole}" is not declared in parent roles.primary or roles.participants`,
      }));
    }
  }

  if (childRoles) {
    for (const childRole of childRoles) {
      if (!Object.hasOwn(step.bind, childRole)) {
        diagnostics.push(createDiagnostic({
          file: entity.file,
          path: `${fieldPath}.bind`,
          message: `child workflow role "${childRole}" is not bound`,
        }));
      }
    }
  }

  return diagnostics;
}

function validateWorkflowReferenceStep({ entity, index, stats, step, stepIndex, declaredRoles }) {
  const diagnostics = [];
  const fieldPath = `steps[${stepIndex}]`;

  diagnostics.push(...validateWorkflowStepFields({
    entity,
    step,
    fieldPath,
    allowedFields: WORKFLOW_REFERENCE_STEP_ALLOWED_FIELDS,
    variantDescription: 'workflow reference steps support only "workflow" and "bind" fields',
  }));

  for (const field of Object.keys(step)) {
    if (WORKFLOW_REFERENCE_STEP_CAPABILITY_FIELDS.has(field)) {
      diagnostics.push(createDiagnostic({
        file: entity.file,
        path: `${fieldPath}.${field}`,
        message: `workflow reference steps must not contain capability-step field "${field}"`,
      }));
    }
  }

  diagnostics.push(...validateRequiredNonEmptyString({
    entity,
    path: `${fieldPath}.workflow`,
    value: step.workflow,
    fieldName: 'workflow',
  }));

  if (isNonEmptyString(step.workflow)) {
    diagnostics.push(...validateWorkflowReference({
      entity,
      index,
      path: `${fieldPath}.workflow`,
      value: step.workflow,
      stats,
    }));
  }

  diagnostics.push(...validateWorkflowReferenceBind({ entity, index, step, fieldPath, declaredRoles }));

  return diagnostics;
}

function validateWorkflowEventEmissionFields(entity) {
  return WORKFLOW_EVENT_EMISSION_FIELDS
    .filter((field) => Object.hasOwn(entity.document, field))
    .map((field) => createDiagnostic({
      file: entity.file,
      path: field,
      message: `workflows do not support top-level event-emission field "${field}"; events are modeled as independent observable occurrences`,
    }));
}

function validateWorkflow(entity, index, stats) {
  const diagnostics = validateWorkflowEventEmissionFields(entity);
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
        if (Object.hasOwn(step, 'workflow')) {
          diagnostics.push(...validateWorkflowReferenceStep({ entity, index, stats, step, stepIndex, declaredRoles }));
          return;
        }

        diagnostics.push(...validateObjectWorkflowStep({ entity, index, stats, step, stepIndex, declaredRoles }));
        return;
      }

      diagnostics.push(createDiagnostic({
        file: entity.file,
        path: fieldPath,
        message: 'workflow step must be an object with either explicit capability step fields or workflow reference fields',
      }));
    });
  }

  return diagnostics;
}


const SEMANTIC_AREA_ALLOWED_FIELDS = new Set(['name', 'description', 'workflows', 'notes']);
const SEMANTIC_AREA_FORBIDDEN_FIELDS = new Set([
  'kind',
  'owns',
  'model_refs',
  'component',
  'components',
  'component_refs',
  'components_refs',
]);

function validateSemanticArea(entity, index, stats) {
  const diagnostics = [];

  for (const field of Object.keys(entity.document)) {
    if (SEMANTIC_AREA_ALLOWED_FIELDS.has(field)) {
      continue;
    }

    diagnostics.push(createDiagnostic({
      file: entity.file,
      path: field,
      message: SEMANTIC_AREA_FORBIDDEN_FIELDS.has(field)
        ? `semantic areas must not use top-level field "${field}"`
        : `unsupported semantic area field "${field}"; expected only name, description, workflows, and notes`,
    }));
  }

  const workflows = getValueAtPath(entity.document, ['workflows']);
  if (workflows === undefined) {
    return diagnostics;
  }

  if (!Array.isArray(workflows)) {
    return [
      ...diagnostics,
      createDiagnostic({
        file: entity.file,
        path: 'workflows',
        message: 'SemanticArea.workflows must be an array of workflow references',
      }),
    ];
  }

  const seen = new Set();
  workflows.forEach((workflow, workflowIndex) => {
    const workflowPath = `workflows[${workflowIndex}]`;
    if (!isNonEmptyString(workflow)) {
      diagnostics.push(createDiagnostic({
        file: entity.file,
        path: workflowPath,
        message: 'SemanticArea.workflows entries must be non-empty strings',
      }));
      return;
    }

    diagnostics.push(...validateReference({
      entity,
      index,
      path: workflowPath,
      value: workflow,
      targetScope: 'workflows',
      stats,
    }));

    if (seen.has(workflow)) {
      diagnostics.push(createDiagnostic({
        severity: 'warning',
        file: entity.file,
        path: workflowPath,
        message: 'SemanticArea.workflows contains duplicate workflow reference',
      }));
      return;
    }

    seen.add(workflow);
  });

  return diagnostics;
}

function semanticAreaWorkflowOwnerships(entities, index) {
  const workflowIndex = index.get('workflows') ?? new Map();
  const ownerships = new Map();

  for (const entity of entities) {
    if (entity.scope !== 'semantic-areas' || !isPlainObject(entity.document)) {
      continue;
    }

    const workflows = getValueAtPath(entity.document, ['workflows']);
    if (!Array.isArray(workflows)) {
      continue;
    }

    const areaWorkflows = new Set();
    for (let workflowIndexInArea = 0; workflowIndexInArea < workflows.length; workflowIndexInArea += 1) {
      const workflow = workflows[workflowIndexInArea];
      if (!isNonEmptyString(workflow) || !workflowIndex.has(workflow) || areaWorkflows.has(workflow)) {
        continue;
      }

      areaWorkflows.add(workflow);
      if (!ownerships.has(workflow)) {
        ownerships.set(workflow, []);
      }
      ownerships.get(workflow).push({ entity, path: `workflows[${workflowIndexInArea}]` });
    }
  }

  return ownerships;
}

function validateSemanticAreaWorkflowOwnership(entities, index) {
  const diagnostics = [];
  const semanticAreaCount = index.get('semantic-areas')?.size ?? 0;
  if (semanticAreaCount === 0) {
    return diagnostics;
  }

  const ownerships = semanticAreaWorkflowOwnerships(entities, index);

  for (const [workflow, owners] of ownerships.entries()) {
    const uniqueOwnerIds = new Set(owners.map(({ entity }) => entity.identity));
    if (uniqueOwnerIds.size <= 1) {
      continue;
    }

    for (const owner of owners) {
      diagnostics.push(createDiagnostic({
        file: owner.entity.file,
        path: owner.path,
        message: `workflow "${workflow}" is listed by more than one semantic area`,
      }));
    }
  }

  const ownedWorkflows = new Set(ownerships.keys());
  const workflowEntities = [...(index.get('workflows')?.values() ?? [])].sort((left, right) => left.file.localeCompare(right.file));
  for (const workflow of workflowEntities) {
    if (!ownedWorkflows.has(workflow.identity)) {
      diagnostics.push(createDiagnostic({
        severity: 'warning',
        file: workflow.file,
        message: 'workflow is not listed by any semantic area',
      }));
    }
  }

  return diagnostics;
}

function validateCapabilityUseReference({ entity, index, stats, path: fieldPath, value }) {
  if (typeof value !== 'string') {
    return [createDiagnostic({
      file: entity.file,
      path: fieldPath,
      message: 'Capability.uses entries must be strings',
    })];
  }

  if (isRelativeReference(value)) {
    return [createDiagnostic({
      file: entity.file,
      path: fieldPath,
      message: 'Capability.uses reference must be a path identity, not a filesystem-relative reference',
    })];
  }

  stats.references.checked += 1;

  if (!index.get('capabilities')?.has(value)) {
    stats.references.missing += 1;
    return [createDiagnostic({
      file: entity.file,
      path: fieldPath,
      message: 'Capability.uses reference does not resolve',
    })];
  }

  return [];
}

function validateCapabilityUses(entity, index, stats) {
  const diagnostics = [];
  const uses = getValueAtPath(entity.document, ['uses']);

  if (uses === undefined) {
    return diagnostics;
  }

  if (!Array.isArray(uses)) {
    return [createDiagnostic({
      file: entity.file,
      path: 'uses',
      message: 'Capability.uses must be an array',
    })];
  }

  const seen = new Map();
  uses.forEach((usedCapability, useIndex) => {
    const usePath = `uses[${useIndex}]`;
    diagnostics.push(...validateCapabilityUseReference({
      entity,
      index,
      stats,
      path: usePath,
      value: usedCapability,
    }));

    if (typeof usedCapability !== 'string') {
      return;
    }

    if (usedCapability === entity.identity) {
      diagnostics.push(createDiagnostic({
        file: entity.file,
        path: usePath,
        message: 'Capability must not directly use itself',
      }));
    }

    if (seen.has(usedCapability)) {
      diagnostics.push(createDiagnostic({
        severity: 'warning',
        file: entity.file,
        path: usePath,
        message: 'Capability.uses contains duplicate capability reference',
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
            message: `Capability.uses cycle detected: ${cyclePath}`,
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


function workflowReferenceIdentity(step) {
  if (!isPlainObject(step) || !Object.hasOwn(step, 'workflow')) {
    return undefined;
  }

  const normalized = normalizeWorkflowReference(step.workflow);
  if (!isNonEmptyString(normalized) || isRelativeReference(normalized)) {
    return undefined;
  }

  return normalized;
}

function getWorkflowCompositionGraph(entities, index) {
  const workflowIndex = index.get('workflows') ?? new Map();
  const graph = new Map();

  for (const entity of entities) {
    if (entity.scope !== 'workflows' || !isPlainObject(entity.document)) {
      continue;
    }

    const steps = getValueAtPath(entity.document, ['steps']);
    if (!Array.isArray(steps)) {
      graph.set(entity.identity, []);
      continue;
    }

    const references = steps
      .map((step) => workflowReferenceIdentity(step))
      .filter((identity) => identity && workflowIndex.has(identity));
    graph.set(entity.identity, [...new Set(references)]);
  }

  return graph;
}

function validateWorkflowCompositionCycles(entities, index) {
  const diagnostics = [];
  const graph = getWorkflowCompositionGraph(entities, index);
  const workflowIndex = index.get('workflows') ?? new Map();
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
          const cyclePath = [...cycleNodes, nextIdentity]
            .map((workflowIdentity) => `workflows/${workflowIdentity}`)
            .join(' -> ');
          const cycleStart = workflowIndex.get(cycleNodes[0]);
          diagnostics.push(createDiagnostic({
            file: cycleStart?.file ?? '',
            path: 'steps',
            message: `workflow composition cycle detected: ${cyclePath}`,
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
  if (isPlainObject(step) && typeof step.capability === 'string') {
    return step.capability;
  }

  return undefined;
}

function workflowStepCapabilityPath(step, stepIndex) {
  return `steps[${stepIndex}].capability`;
}

function validateWorkflowCapabilityDecompositionOverlap(entities, index) {
  const diagnostics = [];
  const graph = getCapabilityUsesGraph(entities, index);
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

        if ((graph.get(right.identity) ?? []).includes(left.identity)) {
          diagnostics.push(createDiagnostic({
            severity: 'warning',
            file: entity.file,
            path: right.path,
            message: `workflow step capability "${right.identity}" directly uses workflow step capability "${left.identity}"`,
          }));
        } else if ((graph.get(left.identity) ?? []).includes(right.identity)) {
          diagnostics.push(createDiagnostic({
            severity: 'warning',
            file: entity.file,
            path: left.path,
            message: `workflow step capability "${left.identity}" directly uses workflow step capability "${right.identity}"`,
          }));
        }
      }
    }
  }

  return diagnostics;
}


const SUSPICIOUS_EVENT_IDENTITY_SUFFIXES = Object.freeze([
  '_succeeded',
  '_success',
  '_failed',
  '_failure',
  '_rejected',
  '_rejection',
  '_returned',
  '_completed',
  '_handled',
  '_result',
  '_response_returned',
  '_request_rejected',
  '_problem_response',
  '_status',
]);

const SUSPICIOUS_EVENT_IDENTITY_TERMS = Object.freeze([
  'success',
  'failure',
  'result',
  'status',
  'response_returned',
  'request_rejected',
  'problem_response',
]);

function eventIdentityName(identity) {
  return identity.split('/').at(-1).toLowerCase();
}

function isSuspiciousEventIdentity(identity) {
  const name = eventIdentityName(identity);
  return SUSPICIOUS_EVENT_IDENTITY_TERMS.includes(name)
    || SUSPICIOUS_EVENT_IDENTITY_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function validateEventName(entity) {
  if (!isSuspiciousEventIdentity(entity.identity)) {
    return [];
  }

  return [createDiagnostic({
    severity: 'warning',
    file: entity.file,
    message: 'event name looks like a generic outcome/status/helper label; ensure this event is a meaningful observable occurrence',
  })];
}

function validateEntityReferences(entity, index, stats) {
  if (entity.scope === 'events') {
    return validateEventName(entity);
  }

  if (!isPlainObject(entity.document)) {
    return [];
  }

  switch (entity.scope) {
    case 'workflows':
      return validateWorkflow(entity, index, stats);
    case 'semantic-areas':
      return validateSemanticArea(entity, index, stats);
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

export async function validateWorkspace(workspace) {
  const loadedModel = await loadModel(workspace);
  const stats = createReferenceStats();
  const diagnostics = [...loadedModel.diagnostics];

  for (const entity of loadedModel.entities) {
    diagnostics.push(...validateIdentity(entity));
  }

  for (const entity of loadedModel.entities) {
    diagnostics.push(...validateEntityReferences(entity, loadedModel.index, stats));
  }

  diagnostics.push(...validateCapabilityUsesCycles(loadedModel.entities, loadedModel.index));
  diagnostics.push(...validateWorkflowCompositionCycles(loadedModel.entities, loadedModel.index));
  diagnostics.push(...validateWorkflowCapabilityDecompositionOverlap(loadedModel.entities, loadedModel.index));
  diagnostics.push(...validateSemanticAreaWorkflowOwnership(loadedModel.entities, loadedModel.index));

  return {
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    diagnostics,
    entities: loadedModel.entities,
    index: loadedModel.index,
    referenceIndex: loadedModel.referenceIndex,
    summary: createValidationSummary(loadedModel.index, stats),
    coverage: createCoverage(loadedModel.entities, loadedModel.index),
  };
}

export async function validateModel(modelDir) {
  const workspace = new FilesystemWorkspace(modelDir);
  if (!await workspace.exists()) {
    return {
      valid: false,
      diagnostics: [createDiagnostic({
        file: path.basename(modelDir) || modelDir,
        message: `model directory does not exist: ${modelDir}`,
      })],
      entities: [],
      index: new Map(),
      referenceIndex: createEmptyReferenceIndex(),
      summary: createValidationSummary(new Map(), createReferenceStats()),
      coverage: createCoverage([], new Map()),
    };
  }

  return validateWorkspace(workspace);
}
