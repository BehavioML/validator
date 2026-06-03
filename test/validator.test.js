import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatSummary, runCli, validateModel } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');


function coverageFixtureFiles() {
  return {
    'workflows/entry.yaml': 'steps:\n  - cap/used\n',
    'workflows/triggered.yaml': 'roles:\n  primary: client\ntriggered_by:\n  - used_event\nsteps:\n  - cap/used\n',
    'roles/client.yaml': 'description: Client role.\n',
    'capabilities/cap/used.yaml': 'uses:\n  - cap/used_by_use\nrequires:\n  - req\nevents:\n  - used_event\n',
    'capabilities/cap/no_events.yaml': 'description: Implemented helper.\n',
    'capabilities/cap/used_by_use.yaml': 'events:\n  - transition_event\n',
    'events/used_event.yaml': 'description: Used event.\n',
    'events/transition_event.yaml': 'description: Transition event.\n',
    'events/unused_event.yaml': 'description: Unused event.\n',
    'interfaces/req.yaml': 'description: Required interface.\n',
    'interfaces/impl.yaml': 'description: Implemented interface.\n',
    'components/implemented.yaml': 'implements:\n  capabilities:\n    - cap/no_events\n  interfaces:\n    - impl\nbelongs_to: used\n',
    'components/empty.yaml': 'description: Empty component.\n',
    'modules/used.yaml': 'description: Used module.\n',
    'modules/unused.yaml': 'description: Unused module.\n',
    'entities/with_sm.yaml': 'description: Entity with state machine.\n',
    'entities/without_sm.yaml': 'description: Entity without state machine.\n',
    'state-machines/connection/lifecycle.yaml': [
      'entity: with_sm',
      'states:',
      '  - idle',
      '  - open',
      '  - stranded',
      'transitions:',
      '  - from:',
      '      - idle',
      '    to: open',
      '    on: transition_event',
    ].join('\n'),
    'state-machines/connection/empty.yaml': 'description: Empty state machine.\n',
    'decisions/missing-affects.yaml': 'description: Missing affects.\n',
    'decisions/with-affects.yaml': 'affects:\n  - events:used_event\n',
  };
}

async function createTempModel(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'behavioml-validator-'));
  const modelDir = path.join(root, 'model');
  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(modelDir, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents);
  }
  return modelDir;
}

test('validates the valid minimal fixture', async () => {
  const modelDir = path.join(fixturesDir, 'valid-minimal', 'model');
  const result = await validateModel(modelDir);

  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.summary, {
    scopes: {
      workflows: 1,
      roles: 2,
      capabilities: 2,
      interfaces: 0,
      components: 0,
      modules: 0,
      events: 1,
      entities: 0,
      'state-machines': 0,
      decisions: 0,
    },
    references: {
      checked: 5,
      missing: 0,
    },
  });
});

test('reports a missing workflow step capability reference', async () => {
  const modelDir = path.join(fixturesDir, 'invalid-missing-reference', 'model');
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.length, 1);
  assert.deepEqual(result.diagnostics[0], {
    severity: 'error',
    file: 'workflows/client/handle_handshake_failure.yaml',
    path: 'steps[0]',
    message: 'missing capability "connection/missing_capability"',
  });
  assert.deepEqual(result.summary.references, {
    checked: 4,
    missing: 1,
  });
});

test('ignores non-directory top-level scope entries', async () => {
  const modelDir = await createTempModel({
    workflows: 'not a directory\n',
    'capabilities/connection/send_connection_close.yaml': 'description: Close connection.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
});

test('rejects reserved top-level identity fields', async () => {
  const modelDir = await createTempModel({
    'roles/client.yaml': 'id: client\ndescription: Client role.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].path, 'id');
  assert.match(result.diagnostics[0].message, /identity is derived from the file path/u);
});

test('rejects filesystem-relative references', async () => {
  const modelDir = await createTempModel({
    'workflows/client/bad.yaml': 'steps:\n  - ../capabilities/connection/send_connection_close\n',
    'capabilities/connection/send_connection_close.yaml': 'description: Close connection.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].path, 'steps[0]');
  assert.match(result.diagnostics[0].message, /not a filesystem-relative reference/u);
});

test('rejects invalid decision polymorphic references', async () => {
  const modelDir = await createTempModel({
    'decisions/bad.yaml': 'affects:\n  - events://handshake_failed\n',
    'events/handshake_failed.yaml': 'description: Handshake failed.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].path, 'affects[0]');
  assert.match(result.diagnostics[0].message, /URL-like syntax/u);
});

test('reports unsupported object workflow steps', async () => {
  const modelDir = await createTempModel({
    'workflows/client/object-step.yaml': 'steps:\n  - capability: connection/send_connection_close\n',
    'capabilities/connection/send_connection_close.yaml': 'description: Close connection.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].path, 'steps[0]');
  assert.match(result.diagnostics[0].message, /unsupported/u);
});


test('formats validation summaries as plain text', () => {
  const output = formatSummary({
    scopes: {
      workflows: 1,
      roles: 2,
      capabilities: 2,
      interfaces: 0,
      components: 0,
      modules: 0,
      events: 1,
      entities: 0,
      'state-machines': 0,
      decisions: 0,
    },
    references: {
      checked: 5,
      missing: 0,
    },
  });

  assert.equal(output, [
    'Model summary:',
    '  workflows:       1',
    '  roles:           2',
    '  capabilities:    2',
    '  interfaces:      0',
    '  components:      0',
    '  modules:         0',
    '  events:          1',
    '  entities:        0',
    '  state-machines:  0',
    '  decisions:       0',
    '',
    'References checked:',
    '  total:           5',
    '  missing:         0',
  ].join('\n'));
});

test('prints summary on successful CLI validation', async () => {
  const modelDir = path.join(fixturesDir, 'valid-minimal', 'model');
  let stdout = '';
  let stderr = '';

  const exitCode = await runCli([modelDir], {
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /^BehavioML model is valid\.\n\nModel summary:/u);
  assert.match(stdout, /References checked:\n  total:           5\n  missing:         0\n\nCoverage:\n  capabilities without events:\s+2\n$/u);
});

test('does not count invalid typed reference syntax as checked', async () => {
  const modelDir = await createTempModel({
    'decisions/bad.yaml': 'affects:\n  - events://handshake_failed\n',
    'events/handshake_failed.yaml': 'description: Handshake failed.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.summary.references, {
    checked: 0,
    missing: 0,
  });
});

test('reports workflow missing steps', async () => {
  const modelDir = await createTempModel({
    'workflows/client/missing-steps.yaml': 'description: Missing steps.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'workflows/client/missing-steps.yaml',
    path: 'steps',
    message: 'required field "steps" is missing',
  }]);
});

test('reports workflow empty steps', async () => {
  const modelDir = await createTempModel({
    'workflows/client/empty-steps.yaml': 'steps: []\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'workflows/client/empty-steps.yaml',
    path: 'steps',
    message: 'expected a non-empty array of capability references',
  }]);
});

test('reports workflow non-array steps', async () => {
  const modelDir = await createTempModel({
    'workflows/client/non-array-steps.yaml': 'steps: connection/send_connection_close\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'workflows/client/non-array-steps.yaml',
    path: 'steps',
    message: 'expected a non-empty array of capability references',
  }]);
});

test('reports capability reference field present but not an array', async () => {
  const modelDir = await createTempModel({
    'capabilities/connection/send_connection_close.yaml': 'uses: connection/close_transport\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'capabilities/connection/send_connection_close.yaml',
    path: 'uses',
    message: 'expected an array of capability references',
  }]);
});

test('reports component belongs_to present but not a string', async () => {
  const modelDir = await createTempModel({
    'components/transport/connection.yaml': 'belongs_to:\n  - modules/transport\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'components/transport/connection.yaml',
    path: 'belongs_to',
    message: 'expected a module reference string',
  }]);
});

test('reports state machine transition from undeclared state', async () => {
  const modelDir = await createTempModel({
    'state-machines/connection/lifecycle.yaml': [
      'states:',
      '  - idle',
      '  - connected',
      'transitions:',
      '  - from: handshaking',
      '    to: connected',
    ].join('\n'),
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'state-machines/connection/lifecycle.yaml',
    path: 'transitions[0].from',
    message: 'state "handshaking" is not declared in states',
  }]);
});

test('reports state machine transition to undeclared state', async () => {
  const modelDir = await createTempModel({
    'state-machines/connection/lifecycle.yaml': [
      'states:',
      '  - idle',
      '  - connected',
      'transitions:',
      '  - from: idle',
      '    to: closed',
    ].join('\n'),
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'state-machines/connection/lifecycle.yaml',
    path: 'transitions[0].to',
    message: 'state "closed" is not declared in states',
  }]);
});


test('accepts state machine transition from as scalar string', async () => {
  const modelDir = await createTempModel({
    'state-machines/connection/lifecycle.yaml': [
      'states:',
      '  - idle',
      '  - connected',
      'transitions:',
      '  - from: idle',
      '    to: connected',
    ].join('\n'),
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
});

test('accepts state machine transition from as non-empty array of strings', async () => {
  const modelDir = await createTempModel({
    'state-machines/connection/lifecycle.yaml': [
      'states:',
      '  - handshaking',
      '  - connected',
      '  - closing',
      'transitions:',
      '  - from:',
      '      - handshaking',
      '      - connected',
      '    to: closing',
    ].join('\n'),
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
});

test('reports state machine transition from as empty array', async () => {
  const modelDir = await createTempModel({
    'state-machines/connection/lifecycle.yaml': [
      'states:',
      '  - idle',
      '  - connected',
      'transitions:',
      '  - from: []',
      '    to: connected',
    ].join('\n'),
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'state-machines/connection/lifecycle.yaml',
    path: 'transitions[0].from',
    message: 'expected transition from state to be a string or non-empty array of strings',
  }]);
});

test('reports state machine transition from array item with undeclared state', async () => {
  const modelDir = await createTempModel({
    'state-machines/connection/lifecycle.yaml': [
      'states:',
      '  - idle',
      '  - connected',
      'transitions:',
      '  - from:',
      '      - idle',
      '      - handshaking',
      '    to: connected',
    ].join('\n'),
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'state-machines/connection/lifecycle.yaml',
    path: 'transitions[0].from[1]',
    message: 'state "handshaking" is not declared in states',
  }]);
});

test('reports state machine transition to as array', async () => {
  const modelDir = await createTempModel({
    'state-machines/connection/lifecycle.yaml': [
      'states:',
      '  - idle',
      '  - connected',
      'transitions:',
      '  - from: idle',
      '    to:',
      '      - connected',
    ].join('\n'),
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'state-machines/connection/lifecycle.yaml',
    path: 'transitions[0].to',
    message: 'expected transition to state to be a string',
  }]);
});

test('reports decision affects present but empty', async () => {
  const modelDir = await createTempModel({
    'decisions/no-affects.yaml': 'affects: []\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'decisions/no-affects.yaml',
    path: 'affects',
    message: 'expected a non-empty array of typed references',
  }]);
});

test('reports coverage counts on a small fixture', async () => {
  const modelDir = await createTempModel(coverageFixtureFiles());
  const result = await validateModel(modelDir);

  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.coverage.counts, {
    'workflows-without-explicit-trigger': 1,
    'workflows-without-primary-role': 1,
    'capabilities-without-events': 1,
    'unused-events': 1,
    'unused-capabilities': 0,
    'interfaces-never-required': 1,
    'interfaces-never-implemented': 1,
    'components-without-implements': 1,
    'components-without-module': 1,
    'modules-without-components': 1,
    'entities-without-state-machine': 1,
    'state-machines-without-states': 1,
    'state-machines-without-transitions': 1,
    'unused-states': 1,
    'decisions-without-affects': 1,
  });
});

test('--warnings all prints detailed occurrences', async () => {
  const modelDir = await createTempModel(coverageFixtureFiles());
  let stdout = '';
  let stderr = '';

  const exitCode = await runCli([modelDir, '--warnings', 'all'], {
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /Warnings:\n\nworkflows without explicit trigger:\n  - workflows\/entry.yaml triggered_by/u);
  assert.match(stdout, /unused capabilities:\n  none/u);
  assert.match(stdout, /unused states:\n  - state-machines\/connection\/lifecycle.yaml states\[2\]/u);
  assert.match(stdout, /decisions without affects:\n  - decisions\/missing-affects.yaml affects/u);
});

test('--warnings unused-events prints only unused events', async () => {
  const modelDir = await createTempModel(coverageFixtureFiles());
  let stdout = '';
  let stderr = '';

  const exitCode = await runCli([modelDir, '--warnings', 'unused-events'], {
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /Warnings:\n\nunused events:\n  - events\/unused_event.yaml/u);
  const warningDetails = stdout.slice(stdout.indexOf('Warnings:'));
  assert.doesNotMatch(warningDetails, /workflows without explicit trigger:/u);
  assert.doesNotMatch(warningDetails, /capabilities without events:/u);
});

test('unknown warning category exits with code 2', async () => {
  let stdout = '';
  let stderr = '';

  const exitCode = await runCli(['model', '--warnings', 'not-real'], {
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /Unknown warning category: not-real/u);
  assert.match(stderr, /Supported warning categories:\n  all\n  workflows-without-explicit-trigger/u);
});

test('coverage warnings do not make a valid model invalid', async () => {
  const modelDir = await createTempModel({
    'workflows/entry.yaml': 'steps:\n  - helper\n',
    'capabilities/helper.yaml': 'description: Internal helper.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.coverage.counts['workflows-without-explicit-trigger'], 1);
  assert.equal(result.coverage.counts['capabilities-without-events'], 1);
});

test('unused-states handles array-valued transition from entries', async () => {
  const modelDir = await createTempModel({
    'state-machines/connection/lifecycle.yaml': [
      'states:',
      '  - handshaking',
      '  - connected',
      '  - closing',
      '  - unused',
      'transitions:',
      '  - from:',
      '      - handshaking',
      '      - connected',
      '    to: closing',
    ].join('\n'),
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.coverage.findings
      .filter((finding) => finding.category === 'unused-states')
      .map((finding) => ({ file: finding.file, path: finding.path })),
    [{ file: 'state-machines/connection/lifecycle.yaml', path: 'states[3]' }],
  );
});
