import path from 'node:path';
import { formatCoverageSummary, formatWarningDetails, WARNING_CATEGORIES } from './coverage.js';
import { formatDiagnostics, hasErrors } from './diagnostics.js';
import { formatSummary } from './summary.js';
import { validateModel } from './validate.js';

function usage() {
  return 'Usage: behavioml-validate <model-dir> [--warnings <category>]';
}

function supportedWarningsMessage() {
  return [
    'Supported warning categories:',
    ...WARNING_CATEGORIES.map((category) => `  ${category}`),
  ].join('\n');
}

function parseArgs(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return { help: true };
  }

  if (args.length === 1) {
    return { modelDir: args[0] };
  }

  if (args.length === 3 && args[1] === '--warnings') {
    return { modelDir: args[0], warnings: args[2] };
  }

  return { usageError: true };
}

export async function runCli(args, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  const parsed = parseArgs(args);

  if (parsed.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  if (parsed.usageError || !parsed.modelDir) {
    stderr.write(`${usage()}\n`);
    return 2;
  }

  if (parsed.warnings && !WARNING_CATEGORIES.includes(parsed.warnings)) {
    stderr.write(`${usage()}\n\nUnknown warning category: ${parsed.warnings}\n\n${supportedWarningsMessage()}\n`);
    return 2;
  }

  const modelDir = path.resolve(cwd, parsed.modelDir);
  const result = await validateModel(modelDir);

  if (result.diagnostics.length > 0) {
    stderr.write(`${formatDiagnostics(result.diagnostics)}\n`);
  }

  if (hasErrors(result.diagnostics)) {
    return result.entities.length === 0 && result.diagnostics.some((diagnostic) => diagnostic.message.startsWith('model directory does not exist')) ? 2 : 1;
  }

  stdout.write(`BehavioML model is valid.\n\n${formatSummary(result.summary)}\n\n${formatCoverageSummary(result.coverage)}\n`);

  if (parsed.warnings) {
    stdout.write(`\n${formatWarningDetails(result.coverage, parsed.warnings)}\n`);
  }

  return 0;
}
