import YAML from 'yaml';
import { createDiagnostic } from './diagnostics.js';
import { SOURCE_SCOPES, isYamlFile } from './rules.js';
import { toWorkspace } from './workspace.js';
import { createReferenceIndex } from './reference-index.js';

function stripYamlExtension(value) {
  return value.replace(/\.ya?ml$/u, '');
}

function pathSegments(value) {
  return value.split('/').filter(Boolean);
}

export async function loadModel(workspaceInput) {
  const workspace = toWorkspace(workspaceInput);
  const workspaceRoot = typeof workspace.getRoot === 'function' ? workspace.getRoot() : undefined;
  const diagnostics = [];
  const entities = [];
  const index = new Map(SOURCE_SCOPES.map((scope) => [scope, new Map()]));

  for (const scope of SOURCE_SCOPES) {
    const files = await workspace.listFiles(scope);
    for (const relativeFile of files) {
      const normalizedFile = relativeFile.replace(/\\/gu, '/');
      const [fileScope, ...scopeRelativeSegments] = pathSegments(normalizedFile);
      if (fileScope !== scope || scopeRelativeSegments.length === 0 || !isYamlFile(normalizedFile)) {
        continue;
      }

      const scopeRelativeFile = scopeRelativeSegments.join('/');
      const identity = stripYamlExtension(scopeRelativeFile);
      const source = await workspace.readFile(relativeFile);
      let document;

      try {
        document = YAML.parse(source);
      } catch (error) {
        diagnostics.push(createDiagnostic({
          file: normalizedFile,
          message: `YAML parse error: ${error.message}`,
        }));
        continue;
      }

      const entity = {
        scope,
        identity,
        file: normalizedFile,
        absoluteFile: typeof workspace.resolveFile === 'function' ? workspace.resolveFile(relativeFile) : normalizedFile,
        document,
      };
      entities.push(entity);

      const scopedIndex = index.get(scope);
      if (scopedIndex.has(identity)) {
        diagnostics.push(createDiagnostic({
          file: normalizedFile,
          message: `duplicate ${scope} identity "${identity}"`,
        }));
      }
      scopedIndex.set(identity, entity);
    }
  }

  const referenceIndex = createReferenceIndex({ entities, index });

  return {
    modelDir: workspaceRoot,
    workspace,
    entities,
    index,
    referenceIndex,
    diagnostics,
  };
}

export const loadWorkspace = loadModel;
