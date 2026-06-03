import path from 'node:path';
import { formatDiagnostics, hasErrors } from './diagnostics.js';
import { formatSummary } from './summary.js';
import { validateModel } from './validate.js';

function usage() {
  return 'Usage: behavioml-validate <model-dir>';
}

export async function runCli(args, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  if (args.length !== 1 || args[0] === '--help' || args[0] === '-h') {
    const stream = args.length === 1 && (args[0] === '--help' || args[0] === '-h') ? stdout : stderr;
    stream.write(`${usage()}\n`);
    return args.length === 1 && (args[0] === '--help' || args[0] === '-h') ? 0 : 2;
  }

  const modelDir = path.resolve(cwd, args[0]);
  const result = await validateModel(modelDir);

  if (result.diagnostics.length > 0) {
    stderr.write(`${formatDiagnostics(result.diagnostics)}\n`);
  }

  if (hasErrors(result.diagnostics)) {
    return result.entities.length === 0 && result.diagnostics.some((diagnostic) => diagnostic.message.startsWith('model directory does not exist')) ? 2 : 1;
  }

  stdout.write(`BehavioML model is valid.\n\n${formatSummary(result.summary)}\n`);
  return 0;
}
