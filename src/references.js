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

export function validateReference({ entity, index, path, value, targetScope }) {
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

  if (!index.get(targetScope)?.has(value)) {
    return [createDiagnostic({
      file: entity.file,
      path,
      message: `missing ${displayName} "${value}"`,
    })];
  }

  return [];
}

export function validateScalarReferenceField({ entity, index, fieldPath, pathSegments, targetScope }) {
  const value = getValueAtPath(entity.document, pathSegments);
  if (value === undefined) {
    return [];
  }

  return validateReference({ entity, index, path: fieldPath, value, targetScope });
}

export function validateArrayReferenceField({ entity, index, fieldPath, pathSegments, targetScope }) {
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
  }));
}

export function validateTypedReference({ entity, index, path, value }) {
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

  if (!index.get(scope)?.has(identity)) {
    const displayName = SCOPE_DISPLAY_NAMES[scope] ?? scope;
    return [createDiagnostic({
      file: entity.file,
      path,
      message: `missing ${displayName} "${identity}"`,
    })];
  }

  return [];
}
