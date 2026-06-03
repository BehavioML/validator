import { createDiagnostic } from './diagnostics.js';

export function validateRequiredArray({ entity, path, value, missingMessage, invalidMessage }) {
  if (value === undefined) {
    return [createDiagnostic({
      file: entity.file,
      path,
      message: missingMessage,
    })];
  }

  if (!Array.isArray(value)) {
    return [createDiagnostic({
      file: entity.file,
      path,
      message: invalidMessage,
    })];
  }

  return [];
}

export function validateOptionalArray({ entity, path, value, message }) {
  if (value === undefined || Array.isArray(value)) {
    return [];
  }

  return [createDiagnostic({
    file: entity.file,
    path,
    message,
  })];
}

export function validateNonEmptyArray({ entity, path, value, message }) {
  if (Array.isArray(value) && value.length > 0) {
    return [];
  }

  return [createDiagnostic({
    file: entity.file,
    path,
    message,
  })];
}

export function validateOptionalString({ entity, path, value, message }) {
  if (value === undefined || typeof value === 'string') {
    return [];
  }

  return [createDiagnostic({
    file: entity.file,
    path,
    message,
  })];
}
