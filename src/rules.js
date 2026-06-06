export const SOURCE_SCOPES = Object.freeze([
  'workflows',
  'semantic-areas',
  'roles',
  'capabilities',
  'interfaces',
  'components',
  'modules',
  'events',
  'entities',
  'state-machines',
  'decisions',
]);

export const IGNORED_SCOPES = Object.freeze(['generated']);

export const RESERVED_TOP_LEVEL_FIELDS = Object.freeze(['id', 'ids', 'uuid', 'uuids']);

export const TYPED_REFERENCE_SCOPES = SOURCE_SCOPES;

export const SCOPE_DISPLAY_NAMES = Object.freeze({
  workflows: 'workflow',
  'semantic-areas': 'semantic area',
  roles: 'role',
  capabilities: 'capability',
  interfaces: 'interface',
  components: 'component',
  modules: 'module',
  events: 'event',
  entities: 'entity',
  'state-machines': 'state machine',
  decisions: 'decision',
});

export function isYamlFile(fileName) {
  return fileName.endsWith('.yaml') || fileName.endsWith('.yml');
}
