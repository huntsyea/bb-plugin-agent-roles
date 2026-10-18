import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGraph, graphLayers, type GraphNodeShape } from './shared.ts';
const node = (id: string, inputs: string[] = []): GraphNodeShape => ({ id, inputs, roleSlug: 'analyst', label: id, prompt: '{task}', final: false });
test('branches merge only after every dependency, regardless of input order', () => {
  const nodes = [node('merge', ['left', 'right']), node('right', ['start']), node('start'), node('left', ['start'])];
  const ordered = validateGraph(nodes).map(n => n.id);
  assert.ok(ordered.indexOf('merge') > ordered.indexOf('left'));
  assert.ok(ordered.indexOf('merge') > ordered.indexOf('right'));
  assert.equal(graphLayers(nodes).get('merge'), 2);
});
test('cycles, self references and dangling links are rejected', () => {
  assert.throws(() => validateGraph([node('a', ['b']), node('b', ['a'])]), /Cycle/);
  assert.throws(() => validateGraph([node('a', ['a'])]), /itself/);
  assert.throws(() => validateGraph([node('a', ['missing'])]), /unknown input/);
});
test('visual coordinates do not change scheduling or mutate nodes', () => {
  const nodes = [{ ...node('a'), position: { x: 900, y: 300 } }, { ...node('b', ['a']), position: { x: 0, y: 0 } }];
  const before = structuredClone(nodes);
  assert.deepEqual(validateGraph(nodes).map(n => n.id), ['a', 'b']);
  assert.equal(graphLayers(nodes).get('b'), 1);
  assert.deepEqual(nodes, before);
});

test('reconnect either end without losing other inputs or changing original data', async () => {
  const { connectGraph } = await import('./shared.ts');
  const nodes = [node('a'), node('b'), node('c', ['a', 'b']), node('d')];
  const before = structuredClone(nodes);
  const movedTarget = connectGraph(nodes, { source: 'a', target: 'd' }, { source: 'a', target: 'c' });
  assert.deepEqual(movedTarget.find(n => n.id === 'c')!.inputs, ['b']);
  assert.deepEqual(movedTarget.find(n => n.id === 'd')!.inputs, ['a']);
  const movedSource = connectGraph(nodes, { source: 'd', target: 'c' }, { source: 'a', target: 'c' });
  assert.deepEqual(movedSource.find(n => n.id === 'c')!.inputs, ['b', 'd']);
  assert.deepEqual(nodes, before);
});
test('invalid reconnect is atomic, existing destination connection is deduplicated', async () => {
  const { connectGraph } = await import('./shared.ts');
  const nodes = [node('a'), node('b', ['a']), node('c', ['b'])];
  const before = structuredClone(nodes);
  assert.throws(() => connectGraph(nodes, { source: 'c', target: 'b' }, { source: 'a', target: 'b' }), /Cycle/);
  assert.throws(() => connectGraph(nodes, { source: 'a', target: 'a' }, { source: 'a', target: 'b' }), /itself/);
  assert.throws(() => connectGraph(nodes, { source: 'a', target: 'missing' }, { source: 'a', target: 'b' }), /endpoint/);
  assert.deepEqual(nodes, before);
  const duplicate = connectGraph([node('a'), node('b', ['a']), node('c', ['a'])], { source: 'a', target: 'c' }, { source: 'a', target: 'b' });
  assert.deepEqual(duplicate[1]!.inputs, []);
  assert.deepEqual(duplicate[2]!.inputs, ['a']);
});

test('role threads inherit the caller environment only within its own project', async () => {
  const { inheritedEnvironmentId } = await import('./shared.ts');
  const caller = { projectId: 'proj_personal', environmentId: 'env_caller' };
  assert.equal(inheritedEnvironmentId(caller, 'proj_personal'), 'env_caller');
  assert.equal(inheritedEnvironmentId(caller, 'proj_other'), null);
  assert.equal(inheritedEnvironmentId(null, 'proj_other'), null);
});

test('an explicit environment wins over a machine, and a machine selects its project checkout', async () => {
  const { roleThreadEnvironment } = await import('./shared.ts');
  assert.deepEqual(roleThreadEnvironment({ environmentId: 'env_1', hostId: 'host_1' }), { type: 'reuse', environmentId: 'env_1' });
  assert.deepEqual(roleThreadEnvironment({ environmentId: null, hostId: 'host_1' }), { type: 'host', hostId: 'host_1', workspace: { type: 'unmanaged', path: null } });
  assert.deepEqual(roleThreadEnvironment({ environmentId: null, hostId: null }), { type: 'project-default' });
});
