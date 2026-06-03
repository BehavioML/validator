import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { createDiagnostic } from './diagnostics.js';
import { SOURCE_SCOPES, isYamlFile } from './rules.js';

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function stripYamlExtension(value) {
  return value.replace(/\.ya?ml$/u, '');
}

async function pathExists(value) {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

async function collectYamlFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectYamlFiles(fullPath));
    } else if (entry.isFile() && isYamlFile(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

export async function loadModel(modelDir) {
  const absoluteModelDir = path.resolve(modelDir);
  const diagnostics = [];
  const entities = [];
  const index = new Map(SOURCE_SCOPES.map((scope) => [scope, new Map()]));

  for (const scope of SOURCE_SCOPES) {
    const scopeDir = path.join(absoluteModelDir, scope);
    if (!await pathExists(scopeDir)) {
      continue;
    }

    const files = await collectYamlFiles(scopeDir);
    for (const absoluteFile of files) {
      const relativeFile = toPosixPath(path.relative(absoluteModelDir, absoluteFile));
      const scopeRelativeFile = toPosixPath(path.relative(scopeDir, absoluteFile));
      const identity = stripYamlExtension(scopeRelativeFile);
      const source = await fs.readFile(absoluteFile, 'utf8');
      let document;

      try {
        document = YAML.parse(source);
      } catch (error) {
        diagnostics.push(createDiagnostic({
          file: relativeFile,
          message: `YAML parse error: ${error.message}`,
        }));
        continue;
      }

      const entity = {
        scope,
        identity,
        file: relativeFile,
        absoluteFile,
        document,
      };
      entities.push(entity);

      const scopedIndex = index.get(scope);
      if (scopedIndex.has(identity)) {
        diagnostics.push(createDiagnostic({
          file: relativeFile,
          message: `duplicate ${scope} identity "${identity}"`,
        }));
      }
      scopedIndex.set(identity, entity);
    }
  }

  return {
    modelDir: absoluteModelDir,
    entities,
    index,
    diagnostics,
  };
}
