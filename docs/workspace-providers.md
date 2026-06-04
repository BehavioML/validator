# Workspace providers

The validator can be embedded in tools that already have BehavioML files loaded without requiring those tools to write files to disk or invoke the CLI as a subprocess. This preparation is intended for future hosts such as the web-based BehavioML Explorer, which may load workspaces from uploaded `.tgz` archives or remote `.tgz` archive URLs before passing model files to the validator.

This abstraction does **not** change BehavioML semantics, validation rules, diagnostics, or CLI behavior. It only separates model loading from direct filesystem access.

## Architecture before

Before workspace providers, validation followed this flow:

```text
filesystem
  -> model directory discovery
  -> recursive YAML file discovery by known source scope
  -> YAML parsing
  -> entity indexing by scope and path identity
  -> reference resolution
  -> validation rules
  -> diagnostics, summary, and coverage
```

The CLI called `validateModel(modelDir)`. `validateModel` checked whether the model directory existed, then `loadModel` directly inspected directories and read files from the local filesystem. Validation and reference resolution operated on the loaded entities and index.

## Architecture after

Validation now follows this flow:

```text
workspace provider
  -> YAML file discovery by known source scope
  -> YAML parsing
  -> entity indexing by scope and path identity
  -> reference resolution
  -> validation rules
  -> diagnostics, summary, and coverage
```

A workspace provider is the minimal source abstraction needed by the loader:

- enumerate workspace files, optionally under a workspace-relative prefix such as `workflows/`
- read file contents
- provide stable path-like file identifiers
- optionally report root information and resolve files for host diagnostics/debugging

The validation rules continue to consume the same loaded entity shape and index. Reference resolution still uses BehavioML scope and path identities, not filesystem-relative references.

## Filesystem provider

`FilesystemWorkspace` is the CLI-backed implementation. It enumerates files under a model directory and reads each file from disk. The CLI still accepts a model directory path and preserves the existing missing-directory exit behavior.

Programmatic example:

```js
import { FilesystemWorkspace, validateWorkspace } from '@behavioml/validator';

const result = await validateWorkspace(new FilesystemWorkspace('examples/quic/model'));
```

`validateModel(modelDir)` remains available as the compatibility API for filesystem validation and is what the CLI uses internally.

## In-memory provider

`InMemoryWorkspace` validates files that a host has already loaded into memory. It does not extract archives, fetch remote URLs, provide browser APIs, or add Explorer-specific behavior.

Programmatic example:

```js
import { InMemoryWorkspace, validateWorkspace } from '@behavioml/validator';

const result = await validateWorkspace(new InMemoryWorkspace([
  {
    path: 'workflows/client/example.yaml',
    content: 'steps:\n  - connection/send_connection_close\n',
  },
  {
    path: 'capabilities/connection/send_connection_close.yaml',
    content: 'description: Close connection.\n',
  },
]));
```

Paths should be stable workspace-relative identifiers. They are normalized to POSIX-style separators so diagnostics remain consistent with filesystem-backed validation.

## Public API

The minimal programmatic API is:

- `validateModel(modelDir)` for existing filesystem validation and CLI compatibility
- `validateWorkspace(workspace)` for provider-backed validation
- `loadModel(workspaceOrModelDir)` / `loadWorkspace(workspaceOrModelDir)` for parsing and indexing without running validation rules
- `FilesystemWorkspace` for local model directories
- `InMemoryWorkspace` for already-loaded file collections

## Deferred work

The provider layer intentionally does not implement:

- archive extraction
- remote archive fetching
- browser-specific file APIs
- WASM support
- a validator-core / validator-cli package split
- Explorer-specific dependencies or APIs
- diagnostics format changes
- validation rule changes
