import { getValueAtPath, isPlainObject } from './references.js';

export const WARNING_CATEGORY_ORDER = Object.freeze([
  'workflows-without-explicit-trigger',
  'workflows-without-primary-role',
  'capabilities-without-events',
  'unused-events',
  'unused-capabilities',
  'interfaces-never-required',
  'interfaces-never-implemented',
  'components-without-implements',
  'components-without-module',
  'modules-without-components',
  'entities-without-state-machine',
  'state-machines-without-states',
  'state-machines-without-transitions',
  'unused-states',
  'decisions-without-affects',
]);

export const WARNING_CATEGORIES = Object.freeze(['all', ...WARNING_CATEGORY_ORDER]);

export const WARNING_CATEGORY_LABELS = Object.freeze({
  'workflows-without-explicit-trigger': 'workflows without explicit trigger',
  'workflows-without-primary-role': 'workflows without primary role',
  'capabilities-without-events': 'capabilities without events',
  'unused-events': 'unused events',
  'unused-capabilities': 'unused capabilities',
  'interfaces-never-required': 'interfaces never required',
  'interfaces-never-implemented': 'interfaces never implemented',
  'components-without-implements': 'components without implements',
  'components-without-module': 'components without module',
  'modules-without-components': 'modules without components',
  'entities-without-state-machine': 'entities without state machine',
  'state-machines-without-states': 'state machines without states',
  'state-machines-without-transitions': 'state machines without transitions',
  'unused-states': 'unused states',
  'decisions-without-affects': 'decisions without affects',
});

const COVERAGE_FIELD_WIDTH = 39;

function hasNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function hasString(value) {
  return typeof value === 'string' && value.length > 0;
}

function stringArrayItems(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function addFinding(findings, category, entity, path, message) {
  findings.push({
    category,
    file: entity.file,
    path,
    message,
  });
}

function collectReferencedStrings(entities, scope, pathSegments) {
  const referenced = new Set();

  for (const entity of entities) {
    if (entity.scope !== scope || !isPlainObject(entity.document)) {
      continue;
    }

    for (const value of stringArrayItems(getValueAtPath(entity.document, pathSegments))) {
      referenced.add(value);
    }
  }

  return referenced;
}

function collectReferencedScalars(entities, scope, pathSegments) {
  const referenced = new Set();

  for (const entity of entities) {
    if (entity.scope !== scope || !isPlainObject(entity.document)) {
      continue;
    }

    const value = getValueAtPath(entity.document, pathSegments);
    if (typeof value === 'string') {
      referenced.add(value);
    }
  }

  return referenced;
}

function addSetItems(target, source) {
  for (const item of source) {
    target.add(item);
  }
}

function collectTransitionEventReferences(entities) {
  const referenced = new Set();

  for (const entity of entities) {
    if (entity.scope !== 'state-machines' || !isPlainObject(entity.document)) {
      continue;
    }

    const transitions = getValueAtPath(entity.document, ['transitions']);
    if (!Array.isArray(transitions)) {
      continue;
    }

    for (const transition of transitions) {
      if (isPlainObject(transition) && typeof transition.on === 'string') {
        referenced.add(transition.on);
      }
    }
  }

  return referenced;
}

function collectTransitionStateReferences(transitions) {
  const referenced = new Set();

  if (!Array.isArray(transitions)) {
    return referenced;
  }

  for (const transition of transitions) {
    if (!isPlainObject(transition)) {
      continue;
    }

    if (typeof transition.from === 'string') {
      referenced.add(transition.from);
    } else if (Array.isArray(transition.from)) {
      addSetItems(referenced, stringArrayItems(transition.from));
    }

    if (typeof transition.to === 'string') {
      referenced.add(transition.to);
    }
  }

  return referenced;
}

function sortedEntities(index, scope) {
  return [...(index.get(scope)?.values() ?? [])].sort((left, right) => left.file.localeCompare(right.file));
}

function buildCounts(findings) {
  return Object.fromEntries(
    WARNING_CATEGORY_ORDER.map((category) => [
      category,
      findings.filter((finding) => finding.category === category).length,
    ]),
  );
}

export function createCoverage(entities, index) {
  const findings = [];

  for (const entity of sortedEntities(index, 'workflows')) {
    if (!isPlainObject(entity.document)) {
      continue;
    }

    if (!hasNonEmptyArray(getValueAtPath(entity.document, ['triggered_by']))) {
      addFinding(findings, 'workflows-without-explicit-trigger', entity, 'triggered_by', 'workflow has no explicit trigger');
    }

    if (!hasString(getValueAtPath(entity.document, ['roles', 'primary']))) {
      addFinding(findings, 'workflows-without-primary-role', entity, 'roles.primary', 'workflow has no roles.primary');
    }
  }

  for (const entity of sortedEntities(index, 'capabilities')) {
    if (isPlainObject(entity.document) && !hasNonEmptyArray(getValueAtPath(entity.document, ['events']))) {
      addFinding(findings, 'capabilities-without-events', entity, 'events', 'capability has no events');
    }
  }

  const referencedCapabilities = collectReferencedStrings(entities, 'workflows', ['steps']);
  addSetItems(referencedCapabilities, collectReferencedStrings(entities, 'capabilities', ['uses']));
  addSetItems(referencedCapabilities, collectReferencedStrings(entities, 'components', ['implements', 'capabilities']));

  for (const entity of sortedEntities(index, 'capabilities')) {
    if (!referencedCapabilities.has(entity.identity)) {
      addFinding(findings, 'unused-capabilities', entity, undefined, 'capability is not referenced');
    }
  }

  const referencedEvents = collectReferencedStrings(entities, 'workflows', ['triggered_by']);
  addSetItems(referencedEvents, collectReferencedStrings(entities, 'capabilities', ['events']));
  addSetItems(referencedEvents, collectTransitionEventReferences(entities));

  for (const entity of sortedEntities(index, 'events')) {
    if (!referencedEvents.has(entity.identity)) {
      addFinding(findings, 'unused-events', entity, undefined, 'event is not referenced');
    }
  }

  const requiredInterfaces = collectReferencedStrings(entities, 'capabilities', ['requires']);
  const implementedInterfaces = collectReferencedStrings(entities, 'components', ['implements', 'interfaces']);

  for (const entity of sortedEntities(index, 'interfaces')) {
    if (!requiredInterfaces.has(entity.identity)) {
      addFinding(findings, 'interfaces-never-required', entity, undefined, 'interface is never required');
    }
    if (!implementedInterfaces.has(entity.identity)) {
      addFinding(findings, 'interfaces-never-implemented', entity, undefined, 'interface is never implemented');
    }
  }

  for (const entity of sortedEntities(index, 'components')) {
    if (!isPlainObject(entity.document)) {
      continue;
    }

    const implementsCapabilities = getValueAtPath(entity.document, ['implements', 'capabilities']);
    const implementsInterfaces = getValueAtPath(entity.document, ['implements', 'interfaces']);
    if (!hasNonEmptyArray(implementsCapabilities) && !hasNonEmptyArray(implementsInterfaces)) {
      addFinding(findings, 'components-without-implements', entity, 'implements', 'component implements no capabilities or interfaces');
    }

    if (!hasString(getValueAtPath(entity.document, ['belongs_to']))) {
      addFinding(findings, 'components-without-module', entity, 'belongs_to', 'component has no belongs_to module');
    }
  }

  const referencedModules = collectReferencedScalars(entities, 'components', ['belongs_to']);
  for (const entity of sortedEntities(index, 'modules')) {
    if (!referencedModules.has(entity.identity)) {
      addFinding(findings, 'modules-without-components', entity, undefined, 'module has no components');
    }
  }

  const stateMachineEntities = collectReferencedScalars(entities, 'state-machines', ['entity']);
  for (const entity of sortedEntities(index, 'entities')) {
    if (!stateMachineEntities.has(entity.identity)) {
      addFinding(findings, 'entities-without-state-machine', entity, undefined, 'entity has no state machine');
    }
  }

  for (const entity of sortedEntities(index, 'state-machines')) {
    if (!isPlainObject(entity.document)) {
      continue;
    }

    const states = getValueAtPath(entity.document, ['states']);
    const transitions = getValueAtPath(entity.document, ['transitions']);
    if (!hasNonEmptyArray(states)) {
      addFinding(findings, 'state-machines-without-states', entity, 'states', 'state machine has no states');
    }
    if (!hasNonEmptyArray(transitions)) {
      addFinding(findings, 'state-machines-without-transitions', entity, 'transitions', 'state machine has no transitions');
    }

    if (Array.isArray(states)) {
      const referencedStates = collectTransitionStateReferences(transitions);
      states.forEach((state, stateIndex) => {
        if (typeof state === 'string' && !referencedStates.has(state)) {
          addFinding(findings, 'unused-states', entity, `states[${stateIndex}]`, `state "${state}" is not referenced by transitions`);
        }
      });
    }
  }

  for (const entity of sortedEntities(index, 'decisions')) {
    if (isPlainObject(entity.document) && !hasNonEmptyArray(getValueAtPath(entity.document, ['affects']))) {
      addFinding(findings, 'decisions-without-affects', entity, 'affects', 'decision has no affects');
    }
  }

  findings.sort((left, right) => {
    const categoryDiff = WARNING_CATEGORY_ORDER.indexOf(left.category) - WARNING_CATEGORY_ORDER.indexOf(right.category);
    if (categoryDiff !== 0) {
      return categoryDiff;
    }
    const fileDiff = left.file.localeCompare(right.file);
    if (fileDiff !== 0) {
      return fileDiff;
    }
    return (left.path ?? '').localeCompare(right.path ?? '');
  });

  return {
    findings,
    counts: buildCounts(findings),
  };
}

function formatCoverageLine(category, count) {
  const label = WARNING_CATEGORY_LABELS[category];
  return `${`  ${label}:`.padEnd(COVERAGE_FIELD_WIDTH)}${count}`;
}

export function formatCoverageSummary(coverage) {
  const categoriesWithFindings = WARNING_CATEGORY_ORDER.filter((category) => (coverage?.counts?.[category] ?? 0) > 0);

  if (categoriesWithFindings.length === 0) {
    return ['Coverage:', '  none'].join('\n');
  }

  return [
    'Coverage:',
    ...categoriesWithFindings.map((category) => formatCoverageLine(category, coverage.counts[category])),
  ].join('\n');
}

function formatFinding(finding) {
  return finding.path ? `  - ${finding.file} ${finding.path}` : `  - ${finding.file}`;
}

export function formatWarningDetails(coverage, category) {
  const categories = category === 'all' ? WARNING_CATEGORY_ORDER : [category];
  const findings = coverage?.findings ?? [];
  const sections = categories.map((currentCategory) => {
    const matchingFindings = findings.filter((finding) => finding.category === currentCategory);
    const lines = [`${WARNING_CATEGORY_LABELS[currentCategory]}:`];

    if (matchingFindings.length === 0) {
      lines.push('  none');
    } else {
      lines.push(...matchingFindings.map(formatFinding));
    }

    return lines.join('\n');
  });

  return ['Warnings:', '', sections.join('\n\n')].join('\n');
}
