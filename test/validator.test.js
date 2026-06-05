import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FilesystemWorkspace, InMemoryWorkspace, createReferenceIndex, formatSummary, loadWorkspace, runCli, validateModel, validateWorkspace } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');


function coverageFixtureFiles() {
  return {
    'workflows/entry.yaml': 'roles:\n  primary: client\nsteps:\n  - from: client\n    capability: cap/used\n    label: Use capability\n',
    'workflows/triggered.yaml': 'roles:\n  primary: client\ntriggered_by:\n  - used_event\nsteps:\n  - from: client\n    capability: cap/used\n    label: Use capability\n',
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


async function readFixtureWorkspace(modelDir) {
  const workspace = new FilesystemWorkspace(modelDir);
  return Promise.all((await workspace.listFiles()).map(async (file) => ({
    path: file,
    content: await readFile(path.join(modelDir, file), 'utf8'),
  })));
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

async function validateSingleStep(stepLines) {
  const modelDir = await createTempModel({
    'workflows/client/object-step.yaml': [
      'roles:',
      '  primary: client',
      'steps:',
      ...stepLines,
    ].join('\n'),
    'roles/client.yaml': 'description: Client role.\n',
    'capabilities/connection/discard_connection_state.yaml': 'description: Discard connection state.\n',
  });

  return validateModel(modelDir);
}


test('validates through the filesystem workspace provider', async () => {
  const modelDir = path.join(fixturesDir, 'valid-minimal', 'model');
  const result = await validateWorkspace(new FilesystemWorkspace(modelDir));

  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.summary.references, {
    checked: 5,
    missing: 0,
  });
});

test('validates through the in-memory workspace provider', async () => {
  const result = await validateWorkspace(new InMemoryWorkspace([
    {
      path: 'workflows/client/handle_handshake_failure.yaml',
      content: 'roles:\n  primary: client\n  participants:\n    - server\ntriggered_by:\n  - handshake_failed\nsteps:\n  - from: client\n    to: server\n    capability: connection/send_connection_close\n    label: Send connection close\n',
    },
    {
      path: 'roles/client.yaml',
      content: 'description: Client role.\n',
    },
    {
      path: 'roles/server.yaml',
      content: 'description: Server role.\n',
    },
    {
      path: 'events/handshake_failed.yaml',
      content: 'description: Handshake failed.\n',
    },
    {
      path: 'capabilities/connection/send_connection_close.yaml',
      content: 'description: Close connection.\n',
    },
  ]));

  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
});

test('returns equivalent validation results for filesystem and in-memory workspaces', async () => {
  const modelDir = path.join(fixturesDir, 'valid-minimal', 'model');
  const filesystemResult = await validateWorkspace(new FilesystemWorkspace(modelDir));
  const inMemoryResult = await validateWorkspace(new InMemoryWorkspace(await readFixtureWorkspace(modelDir)));

  assert.equal(inMemoryResult.valid, filesystemResult.valid);
  assert.deepEqual(inMemoryResult.diagnostics, filesystemResult.diagnostics);
  assert.deepEqual(inMemoryResult.summary, filesystemResult.summary);
  assert.deepEqual(inMemoryResult.coverage, filesystemResult.coverage);
});

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
    path: 'steps[0].capability',
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
    'workflows/client/bad.yaml': 'roles:\n  primary: client\nsteps:\n  - from: client\n    capability: ../capabilities/connection/send_connection_close\n    label: Bad reference\n',
    'capabilities/connection/send_connection_close.yaml': 'description: Close connection.\n',
    'roles/client.yaml': 'description: Client role.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].path, 'steps[0].capability');
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

test('rejects legacy string workflow steps', async () => {
  const modelDir = await createTempModel({
    'workflows/client/legacy-step.yaml': 'steps:\n  - connection/send_connection_close\n',
    'capabilities/connection/send_connection_close.yaml': 'description: Close connection.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'workflows/client/legacy-step.yaml',
    path: 'steps[0]',
    message: 'workflow step must be an object with explicit "from", optional "to", "capability", and "label"',
  }]);
});

test('accepts object workflow step with from and to roles', async () => {
  const modelDir = await createTempModel({
    'workflows/client/object-step.yaml': [
      'roles:',
      '  primary: client',
      '  participants:',
      '    - server',
      'steps:',
      '  - from: client',
      '    to: server',
      '    capability: connection/send_connection_close',
      '    label: Send close alert',
    ].join('\n'),
    'roles/client.yaml': 'description: Client role.\n',
    'roles/server.yaml': 'description: Server role.\n',
    'capabilities/connection/send_connection_close.yaml': 'description: Close connection.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
});

test('accepts object workflow step with from only', async () => {
  const modelDir = await createTempModel({
    'workflows/client/object-step.yaml': [
      'roles:',
      '  primary: client',
      'steps:',
      '  - from: client',
      '    capability: connection/discard_connection_state',
      '    label: Discard connection state',
    ].join('\n'),
    'roles/client.yaml': 'description: Client role.\n',
    'capabilities/connection/discard_connection_state.yaml': 'description: Discard connection state.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
});

test('reports object workflow step missing capability', async () => {
  const modelDir = await createTempModel({
    'workflows/client/object-step.yaml': [
      'roles:',
      '  primary: client',
      'steps:',
      '  - from: client',
      '    label: Discard connection state',
    ].join('\n'),
    'roles/client.yaml': 'description: Client role.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'workflows/client/object-step.yaml',
    path: 'steps[0].capability',
    message: 'required field "capability" is missing',
  }]);
});

test('reports object workflow step missing from', async () => {
  const modelDir = await createTempModel({
    'workflows/client/object-step.yaml': [
      'roles:',
      '  primary: client',
      'steps:',
      '  - capability: connection/send_connection_close',
      '    label: Send connection close',
    ].join('\n'),
    'roles/client.yaml': 'description: Client role.\n',
    'capabilities/connection/send_connection_close.yaml': 'description: Close connection.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'workflows/client/object-step.yaml',
    path: 'steps[0].from',
    message: 'required field "from" is missing',
  }]);
});

test('reports object workflow step missing label', async () => {
  const result = await validateSingleStep([
    '  - from: client',
    '    capability: connection/discard_connection_state',
  ]);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'workflows/client/object-step.yaml',
    path: 'steps[0].label',
    message: 'required field "label" is missing',
  }]);
});

test('reports object workflow step with empty label', async () => {
  const result = await validateSingleStep([
    '  - from: client',
    '    capability: connection/discard_connection_state',
    '    label: ""',
  ]);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'workflows/client/object-step.yaml',
    path: 'steps[0].label',
    message: 'required field "label" must be a non-empty string',
  }]);
});

test('reports object workflow step to without from', async () => {
  const modelDir = await createTempModel({
    'workflows/client/object-step.yaml': [
      'roles:',
      '  primary: client',
      '  participants:',
      '    - server',
      'steps:',
      '  - to: server',
      '    capability: connection/send_connection_close',
      '    label: Send connection close',
    ].join('\n'),
    'roles/client.yaml': 'description: Client role.\n',
    'roles/server.yaml': 'description: Server role.\n',
    'capabilities/connection/send_connection_close.yaml': 'description: Close connection.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'workflows/client/object-step.yaml',
    path: 'steps[0].from',
    message: 'required field "from" is missing',
  }, {
    severity: 'error',
    file: 'workflows/client/object-step.yaml',
    path: 'steps[0].to',
    message: 'field "to" requires field "from"',
  }]);
});

test('reports object workflow step with invalid from role', async () => {
  const modelDir = await createTempModel({
    'workflows/client/object-step.yaml': [
      'roles:',
      '  primary: client',
      'steps:',
      '  - from: server',
      '    capability: connection/send_connection_close',
      '    label: Send connection close',
    ].join('\n'),
    'roles/client.yaml': 'description: Client role.\n',
    'roles/server.yaml': 'description: Server role.\n',
    'capabilities/connection/send_connection_close.yaml': 'description: Close connection.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'workflows/client/object-step.yaml',
    path: 'steps[0].from',
    message: 'workflow step role "server" is not declared in roles.primary or roles.participants',
  }]);
});

test('reports object workflow step with invalid to role', async () => {
  const modelDir = await createTempModel({
    'workflows/client/object-step.yaml': [
      'roles:',
      '  primary: client',
      'steps:',
      '  - from: client',
      '    to: server',
      '    capability: connection/send_connection_close',
      '    label: Send connection close',
    ].join('\n'),
    'roles/client.yaml': 'description: Client role.\n',
    'roles/server.yaml': 'description: Server role.\n',
    'capabilities/connection/send_connection_close.yaml': 'description: Close connection.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'workflows/client/object-step.yaml',
    path: 'steps[0].to',
    message: 'workflow step role "server" is not declared in roles.primary or roles.participants',
  }]);
});

test('reports object workflow step with at field', async () => {
  const modelDir = await createTempModel({
    'workflows/client/object-step.yaml': [
      'roles:',
      '  primary: client',
      'steps:',
      '  - at: client',
      '    from: client',
      '    capability: connection/discard_connection_state',
      '    label: Discard connection state',
    ].join('\n'),
    'roles/client.yaml': 'description: Client role.\n',
    'capabilities/connection/discard_connection_state.yaml': 'description: Discard connection state.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'workflows/client/object-step.yaml',
    path: 'steps[0].at',
    message: 'workflow steps do not support field "at"; use explicit "from", optional "to", "capability", and "label" fields',
  }]);
});

for (const field of ['action', 'event', 'emits', 'uses']) {
  test(`reports object workflow step with forbidden ${field} field`, async () => {
    const result = await validateSingleStep([
      '  - from: client',
      '    capability: connection/discard_connection_state',
      '    label: Discard connection state',
      field === 'uses' ? '    uses:' : `    ${field}: invalid_value`,
      ...(field === 'uses' ? ['      - connection_id'] : []),
    ]);

    assert.equal(result.valid, false);
    assert.deepEqual(result.diagnostics, [{
      severity: 'error',
      file: 'workflows/client/object-step.yaml',
      path: `steps[0].${field}`,
      message: `workflow steps do not support field "${field}"; use explicit "from", optional "to", "capability", and "label" fields`,
    }]);
  });
}

test('reports object workflow step with non-string label', async () => {
  const modelDir = await createTempModel({
    'workflows/client/object-step.yaml': [
      'roles:',
      '  primary: client',
      'steps:',
      '  - from: client',
      '    capability: connection/discard_connection_state',
      '    label:',
      '      text: Discard connection state',
    ].join('\n'),
    'roles/client.yaml': 'description: Client role.\n',
    'capabilities/connection/discard_connection_state.yaml': 'description: Discard connection state.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'workflows/client/object-step.yaml',
    path: 'steps[0].label',
    message: 'required field "label" must be a non-empty string',
  }]);
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
    message: 'Capability.uses must be an array',
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
    'workflows-without-primary-role': 0,
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
    'workflows/entry.yaml': 'roles:\n  primary: client\nsteps:\n  - from: client\n    capability: helper\n    label: Run helper\n',
    'capabilities/helper.yaml': 'description: Internal helper.\n',
    'roles/client.yaml': 'description: Client role.\n',
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

test('accepts valid ordered capability uses list', async () => {
  const modelDir = await createTempModel({
    'capabilities/oauth/authorize_client.yaml': 'uses:\n  - oauth/validate_client\n  - oauth/issue_token\n',
    'capabilities/oauth/validate_client.yaml': 'description: Validate client credentials.\n',
    'capabilities/oauth/issue_token.yaml': 'description: Issue access token.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
});

test('reports non-array capability uses field', async () => {
  const modelDir = await createTempModel({
    'capabilities/oauth/authorize_client.yaml': 'uses: oauth/validate_client\n',
    'capabilities/oauth/validate_client.yaml': 'description: Validate client credentials.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'capabilities/oauth/authorize_client.yaml',
    path: 'uses',
    message: 'Capability.uses must be an array',
  }]);
});

test('reports non-string capability uses entries', async () => {
  const modelDir = await createTempModel({
    'capabilities/oauth/authorize_client.yaml': 'uses:\n  - 42\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'capabilities/oauth/authorize_client.yaml',
    path: 'uses[0]',
    message: 'Capability.uses entries must be strings',
  }]);
});

test('reports missing capability uses references', async () => {
  const modelDir = await createTempModel({
    'capabilities/oauth/authorize_client.yaml': 'uses:\n  - oauth/missing_capability\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'capabilities/oauth/authorize_client.yaml',
    path: 'uses[0]',
    message: 'Capability.uses reference does not resolve',
  }]);
});

test('reports direct capability self-use', async () => {
  const modelDir = await createTempModel({
    'capabilities/oauth/validate_client.yaml': 'uses:\n  - oauth/validate_client\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics, [{
    severity: 'error',
    file: 'capabilities/oauth/validate_client.yaml',
    path: 'uses[0]',
    message: 'Capability must not directly use itself',
  }]);
});

test('warns for duplicate direct capability uses', async () => {
  const modelDir = await createTempModel({
    'capabilities/oauth/authorize_client.yaml': 'uses:\n  - oauth/validate_client\n  - oauth/validate_client\n',
    'capabilities/oauth/validate_client.yaml': 'description: Validate client credentials.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, [{
    severity: 'warning',
    file: 'capabilities/oauth/authorize_client.yaml',
    path: 'uses[1]',
    message: 'Capability.uses contains duplicate capability reference',
  }]);
});

test('warns for capability uses cycles with cycle path', async () => {
  const modelDir = await createTempModel({
    'capabilities/cycle/a.yaml': 'uses:\n  - cycle/b\n',
    'capabilities/cycle/b.yaml': 'uses:\n  - cycle/c\n',
    'capabilities/cycle/c.yaml': 'uses:\n  - cycle/a\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, true);
  assert.equal(result.diagnostics.length, 1);
  assert.deepEqual(result.diagnostics[0], {
    severity: 'warning',
    file: 'capabilities/cycle/a.yaml',
    path: 'uses',
    message: 'Capability.uses cycle detected: cycle/a -> cycle/b -> cycle/c -> cycle/a',
  });
});

test('warns when workflow steps duplicate direct capability decomposition', async () => {
  const modelDir = await createTempModel({
    'workflows/oauth/authorize.yaml': 'roles:\n  primary: client\nsteps:\n  - from: client\n    capability: oauth/validate_client\n    label: Validate client\n  - from: client\n    capability: oauth/authorize_client\n    label: Authorize client\n',
    'capabilities/oauth/authorize_client.yaml': 'uses:\n  - oauth/validate_client\n',
    'capabilities/oauth/validate_client.yaml': 'description: Validate client credentials.\n',
    'roles/client.yaml': 'description: Client role.\n',
  });
  const result = await validateModel(modelDir);

  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, [{
    severity: 'warning',
    file: 'workflows/oauth/authorize.yaml',
    path: 'steps[1].capability',
    message: 'workflow step capability "oauth/authorize_client" directly uses workflow step capability "oauth/validate_client"',
  }]);
});

test('validates representative OAuth and QUIC capability uses examples', async () => {
  const oauthModelDir = await createTempModel({
    'workflows/oauth/authorize.yaml': 'roles:\n  primary: client\nsteps:\n  - from: client\n    capability: oauth/authorize_client\n    label: Authorize client\n',
    'capabilities/oauth/authorize_client.yaml': 'uses:\n  - oauth/validate_client\n  - oauth/issue_token\n',
    'capabilities/oauth/validate_client.yaml': 'description: Validate client credentials.\n',
    'capabilities/oauth/issue_token.yaml': 'description: Issue access token.\n',
    'roles/client.yaml': 'description: Client role.\n',
  });
  const quicModelDir = await createTempModel({
    'workflows/quic/establish_connection.yaml': 'roles:\n  primary: client\nsteps:\n  - from: client\n    capability: quic/complete_handshake\n    label: Complete handshake\n',
    'capabilities/quic/complete_handshake.yaml': 'uses:\n  - quic/validate_transport_parameters\n  - quic/derive_keys\n',
    'capabilities/quic/validate_transport_parameters.yaml': 'description: Validate transport parameters.\n',
    'capabilities/quic/derive_keys.yaml': 'description: Derive handshake keys.\n',
    'roles/client.yaml': 'description: Client role.\n',
  });

  const oauthResult = await validateModel(oauthModelDir);
  const quicResult = await validateModel(quicModelDir);

  assert.equal(oauthResult.valid, true);
  assert.deepEqual(oauthResult.diagnostics, []);
  assert.equal(quicResult.valid, true);
  assert.deepEqual(quicResult.diagnostics, []);
});

function referenceFixtureFiles({ missingCapability = false } = {}) {
  return {
    'workflows/order/process.yaml': [
      'roles:',
      '  primary: buyer',
      '  participants:',
      '    - seller',
      'triggered_by:',
      '  - order/submitted',
      'steps:',
      '  - from: buyer',
      `    capability: ${missingCapability ? 'order/missing' : 'order/validate'}`,
      '    label: Validate order',
      '  - from: buyer',
      '    capability: order/charge',
      '    label: Charge order',
    ].join('\n'),
    'roles/buyer.yaml': 'description: Buyer role.\n',
    'roles/seller.yaml': 'description: Seller role.\n',
    'events/order/submitted.yaml': 'description: Order submitted.\n',
    'events/payment/captured.yaml': 'description: Payment captured.\n',
    'capabilities/order/validate.yaml': 'uses:\n  - order/check_inventory\nrequires:\n  - inventory_api\nevents:\n  - order/submitted\n',
    'capabilities/order/check_inventory.yaml': 'description: Check inventory.\n',
    'capabilities/order/charge.yaml': 'events:\n  - payment/captured\n',
    'interfaces/inventory_api.yaml': 'description: Inventory interface.\n',
    'components/order_processor.yaml': 'implements:\n  capabilities:\n    - order/validate\n  interfaces:\n    - inventory_api\nbelongs_to: order_module\n',
    'modules/order_module.yaml': 'description: Order module.\n',
    'entities/order.yaml': 'description: Order entity.\n',
    'state-machines/order/lifecycle.yaml': 'entity: order\nstates:\n  - submitted\n  - paid\ntransitions:\n  - from: submitted\n    to: paid\n    on: payment/captured\n',
    'decisions/retry.yaml': 'affects:\n  - capabilities:order/validate\n  - events:payment/captured\n',
  };
}

function publicReferences(referenceIndex) {
  return {
    entities: referenceIndex.entities,
    outgoingReferences: referenceIndex.outgoingReferences,
    incomingReferences: referenceIndex.incomingReferences,
    unresolvedReferences: referenceIndex.unresolvedReferences,
  };
}

function findReference(references, { sourceScope, sourceIdentity, fieldPath, targetScope, targetIdentity }) {
  return references.find((reference) => (
    reference.source.scope === sourceScope
    && reference.source.identity === sourceIdentity
    && reference.fieldPath === fieldPath
    && reference.targetScope === targetScope
    && reference.targetIdentity === targetIdentity
  ));
}

test('reference index exposes resolved workflow step capability references', async () => {
  const result = await validateWorkspace(new InMemoryWorkspace(Object.entries(referenceFixtureFiles()).map(([path, content]) => ({ path, content }))));

  assert.equal(result.valid, true);
  assert.equal(result.referenceIndex.entities.length, result.entities.length);

  assert.deepEqual(findReference(result.referenceIndex.outgoingReferences, {
    sourceScope: 'workflows',
    sourceIdentity: 'order/process',
    fieldPath: 'steps[0].capability',
    targetScope: 'capabilities',
    targetIdentity: 'order/validate',
  }), {
    source: { scope: 'workflows', identity: 'order/process', file: 'workflows/order/process.yaml' },
    fieldPath: 'steps[0].capability',
    targetScope: 'capabilities',
    targetIdentity: 'order/validate',
    resolved: true,
    target: { scope: 'capabilities', identity: 'order/validate', file: 'capabilities/order/validate.yaml' },
  });

  assert.deepEqual(findReference(result.referenceIndex.outgoingReferences, {
    sourceScope: 'workflows',
    sourceIdentity: 'order/process',
    fieldPath: 'steps[1].capability',
    targetScope: 'capabilities',
    targetIdentity: 'order/charge',
  })?.target, { scope: 'capabilities', identity: 'order/charge', file: 'capabilities/order/charge.yaml' });
});

test('reference index exposes unresolved workflow step capability references', async () => {
  const result = await validateWorkspace(new InMemoryWorkspace(Object.entries(referenceFixtureFiles({ missingCapability: true })).map(([path, content]) => ({ path, content }))));

  assert.equal(result.valid, false);
  assert.deepEqual(result.referenceIndex.unresolvedReferences, [{
    source: { scope: 'workflows', identity: 'order/process', file: 'workflows/order/process.yaml' },
    fieldPath: 'steps[0].capability',
    targetScope: 'capabilities',
    targetIdentity: 'order/missing',
    resolved: false,
  }]);
});

test('reference index exposes capability uses backlinks', async () => {
  const result = await validateWorkspace(new InMemoryWorkspace(Object.entries(referenceFixtureFiles()).map(([path, content]) => ({ path, content }))));

  assert.deepEqual(findReference(result.referenceIndex.incomingReferences, {
    sourceScope: 'capabilities',
    sourceIdentity: 'order/validate',
    fieldPath: 'uses[0]',
    targetScope: 'capabilities',
    targetIdentity: 'order/check_inventory',
  })?.target, { scope: 'capabilities', identity: 'order/check_inventory', file: 'capabilities/order/check_inventory.yaml' });
});

test('reference index exposes component implements capability backlinks', async () => {
  const result = await validateWorkspace(new InMemoryWorkspace(Object.entries(referenceFixtureFiles()).map(([path, content]) => ({ path, content }))));

  const backlinks = result.referenceIndex.incomingReferences
    .filter((reference) => reference.targetScope === 'capabilities' && reference.targetIdentity === 'order/validate')
    .map((reference) => `${reference.source.scope}:${reference.source.identity}:${reference.fieldPath}`)
    .sort();

  assert.deepEqual(backlinks, [
    'components:order_processor:implements.capabilities[0]',
    'decisions:retry:affects[0]',
    'workflows:order/process:steps[0].capability',
  ]);
});

test('reference index exposes state machine transition event references', async () => {
  const result = await validateWorkspace(new InMemoryWorkspace(Object.entries(referenceFixtureFiles()).map(([path, content]) => ({ path, content }))));

  assert.deepEqual(findReference(result.referenceIndex.outgoingReferences, {
    sourceScope: 'state-machines',
    sourceIdentity: 'order/lifecycle',
    fieldPath: 'transitions[0].on',
    targetScope: 'events',
    targetIdentity: 'payment/captured',
  })?.target, { scope: 'events', identity: 'payment/captured', file: 'events/payment/captured.yaml' });
});

test('reference index exposes decision typed references', async () => {
  const result = await validateWorkspace(new InMemoryWorkspace(Object.entries(referenceFixtureFiles()).map(([path, content]) => ({ path, content }))));

  assert.deepEqual(findReference(result.referenceIndex.outgoingReferences, {
    sourceScope: 'decisions',
    sourceIdentity: 'retry',
    fieldPath: 'affects[1]',
    targetScope: 'events',
    targetIdentity: 'payment/captured',
  })?.target, { scope: 'events', identity: 'payment/captured', file: 'events/payment/captured.yaml' });
});

test('reference index represents unresolved references by missing target', async () => {
  const result = await validateWorkspace(new InMemoryWorkspace([
    { path: 'workflows/a.yaml', content: 'roles:\n  primary: client\nsteps:\n  - from: client\n    capability: missing/shared\n    label: Missing shared\n' },
    { path: 'workflows/b.yaml', content: 'roles:\n  primary: client\nsteps:\n  - from: client\n    capability: missing/shared\n    label: Missing shared\n' },
    { path: 'components/c.yaml', content: 'implements:\n  capabilities:\n    - missing/shared\n' },
  ]));

  const missingSharedReferences = result.referenceIndex.unresolvedReferences
    .filter((reference) => reference.targetScope === 'capabilities' && reference.targetIdentity === 'missing/shared')
    .map((reference) => `${reference.source.file} ${reference.fieldPath}`)
    .sort();

  assert.deepEqual(missingSharedReferences, [
    'components/c.yaml implements.capabilities[0]',
    'workflows/a.yaml steps[0].capability',
    'workflows/b.yaml steps[0].capability',
  ]);
});

test('filesystem and in-memory workspace reference indexes remain equivalent', async () => {
  const modelDir = await createTempModel(referenceFixtureFiles());
  const filesystemResult = await validateWorkspace(new FilesystemWorkspace(modelDir));
  const inMemoryResult = await validateWorkspace(new InMemoryWorkspace(await readFixtureWorkspace(modelDir)));

  assert.deepEqual(publicReferences(inMemoryResult.referenceIndex), publicReferences(filesystemResult.referenceIndex));
});


test('loadWorkspace exposes the same reference index that createReferenceIndex derives', async () => {
  const loaded = await loadWorkspace(new InMemoryWorkspace(Object.entries(referenceFixtureFiles()).map(([path, content]) => ({ path, content }))));

  assert.deepEqual(
    publicReferences(loaded.referenceIndex),
    publicReferences(createReferenceIndex(loaded)),
  );
});
