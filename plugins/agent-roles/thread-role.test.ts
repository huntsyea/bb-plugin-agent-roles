import test from 'node:test';
import assert from 'node:assert/strict';
import { makeThreadRoles, roleBriefing, roleMetadata, metadataRoleSlug, INSTRUCTION_BUDGET } from './thread-role.ts';

const ROLES = { reviewer: { slug: 'reviewer', name: 'Reviewer' }, analyst: { slug: 'analyst', name: 'Analyst' } } as Record<string, { slug: string; name: string }>;
function rolesWith(metadata: Record<string, Record<string, unknown>>, unreadable = new Set<string>()) {
  return makeThreadRoles({
    roleBySlug: (slug) => ROLES[slug] ?? null,
    spawned: (threadId) => (threadId.startsWith('spawned') ? { roleSlug: 'reviewer', taskKey: 'AG-1' } : null),
    metadata: async (threadId) => { if (unreadable.has(threadId)) throw new Error('gone'); return metadata[threadId] ?? {}; },
  });
}

test('the metadata\'s role outranks the role a thread was spawned with; the spawn record fills the gaps', async () => {
  const roles = rolesWith({
    'spawned-picked': roleMetadata({ id: 'r2', slug: 'analyst', name: 'Analyst', color: 'blue' }),
    'spawned-seeded': roleMetadata({ id: 'r1', slug: 'reviewer', name: 'Reviewer', color: 'violet' }, 'AG-1'),
    'picked': roleMetadata({ id: 'r2', slug: 'analyst', name: 'Analyst', color: 'blue' }),
  });
  assert.deepEqual(await roles.lookup('spawned-picked'), { role: ROLES.analyst, taskKey: 'AG-1' });
  assert.deepEqual(await roles.lookup('spawned-seeded'), { role: ROLES.reviewer, taskKey: 'AG-1' });
  assert.deepEqual(await roles.lookup('spawned-no-metadata'), { role: ROLES.reviewer, taskKey: 'AG-1' });
  assert.deepEqual(await roles.lookup('picked'), { role: ROLES.analyst, taskKey: null });
  assert.deepEqual(await roles.lookup('plain'), { role: null, taskKey: null });
  assert.deepEqual(await rolesWith({}, new Set(['spawned-x'])).lookup('spawned-x'), { role: ROLES.reviewer, taskKey: 'AG-1' });
  // configure has the metadata in hand and gets the same answer.
  assert.deepEqual(roles.resolve('spawned-picked', roleMetadata({ id: 'r2', slug: 'analyst', name: 'Analyst', color: 'blue' })), { role: ROLES.analyst, taskKey: 'AG-1' });
});

test('a cleared role means no role, even for a spawned thread, and keeps its task', async () => {
  const roles = rolesWith({ 'spawned-cleared': roleMetadata(null) });
  assert.deepEqual(roleMetadata(null), { roleId: '', roleSlug: '', roleName: '', roleColor: '' });
  assert.equal(metadataRoleSlug(roleMetadata(null)), '');
  assert.equal(metadataRoleSlug({}), undefined);
  assert.equal(metadataRoleSlug({ roleSlug: 7 }), undefined);
  assert.deepEqual(await roles.lookup('spawned-cleared'), { role: null, taskKey: 'AG-1' });
});

test('an unknown role slug in metadata means no role', async () => {
  assert.deepEqual(await rolesWith({ 'spawned-gone': { roleSlug: 'deleted' } }).lookup('spawned-gone'), { role: null, taskKey: 'AG-1' });
});

test('the briefing fits the budget, and says whether instructions were cut and how much room there was', () => {
  const role = { slug: 'reviewer', name: 'Reviewer', description: 'Finds bugs.', instructions: 'Review.' };
  const short = roleBriefing(role, null);
  assert.equal(short.truncated, false);
  assert.match(short.text, /^# Your role: Reviewer\nFinds bugs\.\n\nBegin your first reply with this exact line so BB renders your role card: ::agent-role\{slug="reviewer"\}\n\nReview\.$/);
  assert.equal(short.room, INSTRUCTION_BUDGET - short.text.length + 'Review.'.length);
  const exact = roleBriefing({ ...role, instructions: 'x'.repeat(short.room) }, null);
  assert.equal(exact.truncated, false);
  assert.equal(exact.text.length, INSTRUCTION_BUDGET);
  const over = roleBriefing({ ...role, instructions: 'x'.repeat(short.room + 1) }, null);
  assert.equal(over.truncated, true);
  assert.ok(over.text.length <= INSTRUCTION_BUDGET);
  assert.ok(over.text.endsWith('\n[…truncated]'));
  const withTask = roleBriefing({ ...role, instructions: 'x'.repeat(short.room) }, 'AG-1');
  assert.match(withTask.text, /You are working on task AG-1/);
  assert.ok(withTask.room < short.room, 'a task line leaves less room');
  assert.equal(withTask.truncated, true);
});
