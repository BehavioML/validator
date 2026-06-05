import { createDiagnostic } from './diagnostics.js';
import { SCOPE_DISPLAY_NAMES, TYPED_REFERENCE_SCOPES } from './rules.js';

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function getValueAtPath(value, segments) {
  let current = value;
  for (const segment of segments) {
    if (!isPlainObject(current) && !Array.isArray(current)) {
      return undefined;
    }
    current = current?.[segment];
  }
  return current;
}

export function isRelativeReference(value) {
  return value.startsWith('./') || value.startsWith('../') || value.includes('/../');
}

export function resolveReferenceTarget({ index, targetScope, value }) {
  if (typeof value !== 'string' || isRelativeReference(value)) {
    return { reference: false };
  }

  return {
    reference: true,
    target: index.get(targetScope)?.get(value),
  };
}

export function validateReference({ entity, index, path, value, targetScope, stats }) {
  const displayName = SCOPE_DISPLAY_NAMES[targetScope] ?? targetScope;

  if (typeof value !== 'string') {
    return [createDiagnostic({
      file: entity.file,
      path,
      message: `expected ${displayName} reference to be a string`,
    })];
  }

  if (isRelativeReference(value)) {
    return [createDiagnostic({
      file: entity.file,
      path,
      message: `${displayName} reference "${value}" must be a path identity, not a filesystem-relative reference`,
    })];
  }

  const resolved = resolveReferenceTarget({ index, targetScope, value });
  stats.references.checked += 1;

  if (!resolved.target) {
    stats.references.missing += 1;
    return [createDiagnostic({
      file: entity.file,
      path,
      message: `missing ${displayName} "${value}"`,
    })];
  }

  return [];
}

export function validateScalarReferenceField({ entity, index, fieldPath, pathSegments, targetScope, stats }) {
  const value = getValueAtPath(entity.document, pathSegments);
  if (value === undefined) {
    return [];
  }

  return validateReference({ entity, index, path: fieldPath, value, targetScope, stats });
}

export function validateArrayReferenceField({ entity, index, fieldPath, pathSegments, targetScope, stats }) {
  const value = getValueAtPath(entity.document, pathSegments);
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    return [createDiagnostic({
      file: entity.file,
      path: fieldPath,
      message: 'expected an array of references',
    })];
  }

  return value.flatMap((item, indexWithinArray) => validateReference({
    entity,
    index,
    path: `${fieldPath}[${indexWithinArray}]`,
    value: item,
    targetScope,
    stats,
  }));
}

export function parseTypedReference(value) {
  if (typeof value !== 'string' || value.includes('://')) {
    return undefined;
  }

  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return undefined;
  }

  const scope = value.slice(0, separatorIndex);
  const identity = value.slice(separatorIndex + 1);
  if (!TYPED_REFERENCE_SCOPES.includes(scope) || isRelativeReference(identity)) {
    return undefined;
  }

  return { scope, identity };
}

export function resolveTypedReferenceTarget({ index, value }) {
  const typedReference = parseTypedReference(value);
  if (!typedReference) {
    return { reference: false };
  }

  return {
    reference: true,
    targetScope: typedReference.scope,
    targetIdentity: typedReference.identity,
    target: index.get(typedReference.scope)?.get(typedReference.identity),
  };
}

export function validateTypedReference({ entity, index, path, value, stats }) {
  if (typeof value !== 'string') {
    return [createDiagnostic({
      file: entity.file,
      path,
      message: 'expected typed reference to be a string',
    })];
  }

  if (value.includes('://')) {
    return [createDiagnostic({
      file: entity.file,
      path,
      message: `typed reference "${value}" must use "<scope>:<path-identity>" syntax, not URL-like syntax`,
    })];
  }

  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return [createDiagnostic({
      file: entity.file,
      path,
      message: `invalid typed reference "${value}"; expected "<scope>:<path-identity>"`,
    })];
  }

  const scope = value.slice(0, separatorIndex);
  const identity = value.slice(separatorIndex + 1);
  if (!TYPED_REFERENCE_SCOPES.includes(scope)) {
    return [createDiagnostic({
      file: entity.file,
      path,
      message: `invalid typed reference scope "${scope}"`,
    })];
  }

  if (isRelativeReference(identity)) {
    return [createDiagnostic({
      file: entity.file,
      path,
      message: `typed reference "${value}" must use a path identity, not a filesystem-relative reference`,
    })];
  }

  const resolved = resolveTypedReferenceTarget({ index, value });
  stats.references.checked += 1;

  if (!resolved.target) {
    stats.references.missing += 1;
    const displayName = SCOPE_DISPLAY_NAMES[scope] ?? scope;
    return [createDiagnostic({
      file: entity.file,
      path,
      message: `missing ${displayName} "${identity}"`,
    })];
  }

  return [];
}
