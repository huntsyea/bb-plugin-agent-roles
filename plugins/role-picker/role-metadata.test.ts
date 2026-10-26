import test from 'node:test';
import assert from 'node:assert/strict';
import * as local from './role-metadata.ts';
// Tests aren't bundled, so this one may reach into the sibling plugin: Agent Roles owns the metadata.
import * as owner from '../agent-roles/thread-role.ts';

test('Role Picker\'s copy of the Agent Roles thread metadata matches the owner\'s', () => {
  const role = { id: 'r1', slug: 'qa', name: 'QA', color: 'amber' };
  for (const [r, taskKey] of [[role, undefined], [role, null], [role, 'AG-1'], [null, undefined], [null, 'AG-1']] as const) {
    assert.deepEqual(local.roleMetadata(r, taskKey), owner.roleMetadata(r, taskKey));
  }
  for (const metadata of [{}, { roleSlug: 'qa' }, { roleSlug: '' }, { roleSlug: 7 }, { roleSlug: null }, owner.roleMetadata(role), owner.roleMetadata(null)]) {
    assert.equal(local.metadataRoleSlug(metadata), owner.metadataRoleSlug(metadata));
  }
  assert.deepEqual(Object.keys(local.roleMetadata(role, 'AG-1')), Object.keys(owner.roleMetadata(role, 'AG-1')));
});
