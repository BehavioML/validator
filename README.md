# BehavioML Validator

Experimental validator for BehavioML model directories.

This package implements the current exploratory model rules from the `BehavioML/specifications` repository, especially the model rules and workflow/scenario/event/reference design notes. It validates structural consistency and reference resolution for model source files. It is **not** a final YAML schema validator.

## Status

`@behavioml/validator` is an MVP intended to help authors catch broken BehavioML model directories while the specification is still evolving.

Expect validator behavior to change as the specifications repository changes.

## Installation and usage

Install locally in a project:

```bash
npm install --save-dev @behavioml/validator
```

Run with the package binary:

```bash
behavioml-validate <model-dir>
```

Run without installing globally:

```bash
npx @behavioml/validator <model-dir>
```

Example:

```bash
behavioml-validate examples/quic/model
```

Exit codes:

- `0`: the model is valid
- `1`: validation errors exist
- `2`: CLI usage error, including a missing model directory


### Coverage warnings

Successful validation output includes a compact informational coverage summary after the model and reference summaries:

```text
Coverage:
  workflows without explicit trigger:  4
  capabilities without events:         3
  unused events:                       2
```

Coverage findings are informational. They do **not** make a valid model invalid and do **not** change the exit code unless validation errors also exist.

To drill into warning occurrences, pass `--warnings <category>`:

```bash
behavioml-validate examples/quic/model --warnings all
behavioml-validate examples/quic/model --warnings unused-events
behavioml-validate examples/quic/model --warnings workflows-without-explicit-trigger
```

Detailed output is printed after the compact validation summary:

```text
Warnings:

workflows without explicit trigger:
  - workflows/client/establish_connection.yaml triggered_by
  - workflows/server/accept_connection.yaml triggered_by

capabilities without events:
  - capabilities/connection/validate_peer.yaml events
```

Supported warning categories:

```text
all
workflows-without-explicit-trigger
workflows-without-primary-role
capabilities-without-events
unused-events
unused-capabilities
interfaces-never-required
interfaces-never-implemented
components-without-implements
components-without-module
modules-without-components
entities-without-state-machine
state-machines-without-states
state-machines-without-transitions
unused-states
decisions-without-affects
```


## Embedding and workspace providers

The validator can also be used programmatically through workspace providers. Providers decouple validation from direct filesystem access so hosts can supply files from disk or from memory while preserving the same parsing, reference resolution, validation rules, diagnostics, summaries, and coverage behavior.

This is intended to prepare for embedding in tools such as the BehavioML Explorer. It does not add archive extraction, remote fetching, browser APIs, UI behavior, or Explorer-specific dependencies.

See [Workspace providers](docs/workspace-providers.md) for the architecture notes and API examples.


### Semantic reference index

Programmatic validation and loading results include a `referenceIndex` object for consumer tools that need semantic navigation without parsing YAML or reimplementing Validator reference rules.

```js
import { InMemoryWorkspace, validateWorkspace } from '@behavioml/validator';

const result = await validateWorkspace(new InMemoryWorkspace([
  {
    path: 'workflows/client/example.yaml',
    content: 'roles:\n  primary: client\nsteps:\n  - from: client\n    capability: connection/send_connection_close\n    label: Send connection close\n',
  },
  {
    path: 'capabilities/connection/send_connection_close.yaml',
    content: 'description: Close connection.\n',
  },
]));

console.log(result.referenceIndex.outgoingReferences);
console.log(result.referenceIndex.incomingReferences);
console.log(result.referenceIndex.unresolvedReferences);
```

`loadModel(...)` / `loadWorkspace(...)` also return `referenceIndex` after parsing and indexing. If a host already has a loaded model, it can derive the same structure with `createReferenceIndex(loadedModel)`.

The index shape is:

```js
{
  entities: [
    { scope, identity, file },
  ],
  outgoingReferences: [
    {
      source: { scope, identity, file },
      fieldPath,
      targetScope,
      targetIdentity,
      resolved,
      target: { scope, identity, file }, // present only when resolved
    },
  ],
  incomingReferences: [
    // resolved outgoing references sorted by target, then source
  ],
  unresolvedReferences: [
    // outgoing references with resolved: false and no target
  ],
}
```

The reference index is intentionally semantic rather than textual:

- It is built only from fields Validator already treats as references.
- It does not infer references from arbitrary YAML strings.
- Unresolved entries are included only when the reference has valid reference syntax but the target entity is missing.
- Invalid reference shapes or invalid syntax remain validation diagnostics and are not represented as targetable references.
- Source line and column are not available; use `source.file` and `fieldPath` for navigation.

Covered reference fields are the same typed reference fields listed below, including workflow role, trigger, and step capability references; capability `uses`, `requires`, and `events`; component `implements` and `belongs_to`; state machine `entity` and transition `on`; and decision `affects` typed references.

## What is validated

The validator currently:

- Confirms the input model directory exists.
- Recursively loads `.yaml` and `.yml` files from known BehavioML source scopes.
- Ignores unknown top-level directories, non-YAML files, and `generated/`.
- Parses YAML files.
- Derives entity identity from the file path inside the entity scope.
- Rejects top-level `id`, `ids`, `uuid`, and `uuids` fields.
- Builds an index of entities by scope and path identity.
- Applies minimal entity shape checks for workflows, including sequence-diagrammable object-shaped workflow steps, capabilities, components, state machines, and decisions.
- Requires workflow steps to be objects with non-empty `from`, `capability`, and `label` fields, optional non-empty `to`, and no unsupported step-local fields such as `at`, `action`, `event`, `emits`, or `uses`.
- Resolves semantic references by field type rather than filesystem-relative path.
- Rejects filesystem-relative references beginning with `./`, beginning with `../`, or containing `/../`.
- Reports informational coverage findings separately from validation diagnostics.
- Treats `Capability.uses` entries as ordered capability references for internal decomposition.

Supported source scopes:

```text
workflows/
roles/
capabilities/
interfaces/
components/
modules/
events/
entities/
state-machines/
decisions/
```

Ignored scope:

```text
generated/
```

### Typed reference checks

The MVP validates these reference fields:

- Workflow:
  - `roles.primary -> roles/`
  - `roles.participants[] -> roles/`
  - `steps[].capability -> capabilities/`
  - `triggered_by[] -> events/`
- Capability:
  - `uses[] -> capabilities/` (ordered capability references for internal decomposition; order is preserved by parsers/tools)
  - `requires[] -> interfaces/`
  - `events[] -> events/`
- Component:
  - `implements.capabilities[] -> capabilities/`
  - `implements.interfaces[] -> interfaces/`
  - `belongs_to -> modules/`
- State machine:
  - `entity -> entities/`
  - `transitions[].on -> events/`
- Decision:
  - `affects[] -> <scope>:<path-identity>` polymorphic typed references

Allowed scopes for decision typed references are:

```text
workflows
roles
capabilities
interfaces
components
modules
events
entities
state-machines
decisions
```

URL-like typed references such as `events://handshake_failed` are rejected.

Workflow `steps` currently support scalar string capability references only. Object steps are reported as experimental and unsupported rather than silently accepted.

### Minimal shape checks

The MVP includes a lightweight shape validation layer, not full schema validation. It checks that known reference-bearing fields use the expected scalar string or array shape, requires non-empty `steps` on workflows, requires non-empty `affects` when present on decisions, and verifies state machine transition endpoints against declared `states` when both are present. Capability `uses` entries are ordered capability references. The validator checks their shape, reference resolution, direct self-use, duplicate direct uses, and cycles in the directed `uses` graph; direct self-use is rejected because a capability cannot validly decompose directly into itself. State machine `from` endpoints may be a scalar state or a non-empty array of states; `to` endpoints remain scalar-only. Placeholder entities such as events, roles, interfaces, entities, and modules remain limited to identity checks.

### Structural warnings

The validator emits non-blocking diagnostics with `warning` severity for structural modeling risks that should not make exploratory models invalid yet. Current `Capability.uses` warnings include duplicate direct uses, cycles in the directed `uses` graph, and workflows that include one capability as a top-level step while another step directly uses it as internal decomposition. Capability cycle detection is currently warning-level because cycles are risky for recursive generator/codegen expansion, but BehavioML modeling remains exploratory and should not become too strict prematurely.

## What is not validated yet

The validator intentionally does not implement:

- Final YAML schema validation
- Formatting validation
- Generated view validation
- Editor support
- Graph generation
- Package publishing automation
- Automatic fixing
- Watch mode
- Language server support

It also does not require descriptions, names, summaries, or other presentation metadata.

## Diagnostics

Diagnostics are printed as readable plain text and are also represented internally as structured objects with severity, file path, field path, and message.

Example output:

```text
ERROR workflows/client/foo.yaml steps[1]: missing capability "connection/missing_capability"
ERROR capabilities/auth/login.yaml requires[0]: missing interface "auth/user_repository"
```

## Development

Install dependencies:

```bash
npm install
```

Run tests with Node.js's built-in test runner:

```bash
npm test
```
