import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateModel } from '../src/index.js';

const fixturesDir = path.join(import.meta.dirname, 'fixtures');

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
