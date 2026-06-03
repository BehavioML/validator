export function createDiagnostic({ severity = 'error', file, path = '', message }) {
  return { severity, file, path, message };
}

export function formatDiagnostic(diagnostic) {
  const severity = diagnostic.severity.toUpperCase();
  const location = [diagnostic.file, diagnostic.path].filter(Boolean).join(' ');
  return `${severity} ${location}: ${diagnostic.message}`;
}

export function formatDiagnostics(diagnostics) {
  return diagnostics.map(formatDiagnostic).join('\n');
}

export function hasErrors(diagnostics) {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}
