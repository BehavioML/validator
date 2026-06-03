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

## What is validated

The validator currently:

- Confirms the input model directory exists.
- Recursively loads `.yaml` and `.yml` files from known BehavioML source scopes.
- Ignores unknown top-level directories, non-YAML files, and `generated/`.
- Parses YAML files.
- Derives entity identity from the file path inside the entity scope.
- Rejects top-level `id`, `ids`, `uuid`, and `uuids` fields.
- Builds an index of entities by scope and path identity.
- Resolves semantic references by field type rather than filesystem-relative path.
- Rejects filesystem-relative references beginning with `./`, beginning with `../`, or containing `/../`.

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
  - `steps[] -> capabilities/`
  - `triggered_by[] -> events/`
- Capability:
  - `uses[] -> capabilities/`
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
