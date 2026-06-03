import { SOURCE_SCOPES } from './rules.js';

const SUMMARY_FIELD_WIDTH = 19;

function formatSummaryLine(label, value) {
  return `${`  ${label}:`.padEnd(SUMMARY_FIELD_WIDTH)}${value}`;
}

export function createReferenceStats() {
  return {
    references: {
      checked: 0,
      missing: 0,
    },
  };
}

export function createValidationSummary(index, stats = createReferenceStats()) {
  return {
    scopes: Object.fromEntries(
      SOURCE_SCOPES.map((scope) => [scope, index.get(scope)?.size ?? 0]),
    ),
    references: {
      checked: stats.references.checked,
      missing: stats.references.missing,
    },
  };
}

export function formatSummary(summary) {
  const scopeLines = SOURCE_SCOPES.map((scope) => formatSummaryLine(scope, summary.scopes[scope] ?? 0));
  const referenceLines = [
    formatSummaryLine('total', summary.references.checked),
    formatSummaryLine('missing', summary.references.missing),
  ];

  return [
    'Model summary:',
    ...scopeLines,
    '',
    'References checked:',
    ...referenceLines,
  ].join('\n');
}
