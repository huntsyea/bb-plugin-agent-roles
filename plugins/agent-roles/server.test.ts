import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';

// Resolve the backend's bundler imports when running source with Node.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(import.meta.url.slice(0, import.meta.url.lastIndexOf('/') + 1)) &&
      (specifier === './shared' || specifier === './sync')) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
} });
const { default: plugin } = await import('./server.ts');
const { parseAgentFile, serializeAgentFile } = await import('./sync.ts');

const roleInput = {
  slug: 'test-reviewer', name: 'Reviewer', instructions: 'Review the change.',
  providerId: 'codex', model: 'test-model', reasoningLevel: 'high',
};

test('saved legacy and provider-defined reasoning values reach spawned threads after reload', async () => {
  const spawns: Array<Record<string, unknown>> = [];
  let host = createFakePluginHost({ pluginId: 'agent-roles',
    settings: { syncEnabled: false, syncDefaultReasoning: 'high' },
    sdk: { threads: { spawn: args => { spawns.push(args); return { id: `thread-${spawns.length}` }; } } },
  });
  try {
    await plugin(host.bb);
    const role: any = await host.harness.callRpc('roles_create', roleInput);
    const team: any = await host.harness.callRpc('teams_create', {
      slug: 'review', name: 'Review', nodes: [{ id: 'review', roleSlug: 'test-reviewer', label: 'Review', prompt: '{task}', inputs: [], final: true }],
    });
    host = await host.harness.reload(plugin);
    const sync: any = await host.harness.callRpc('sync_status');
    assert.equal(sync.enabled, false);
    const teams: any = await host.harness.callRpc('teams_list');
    assert.equal(teams.teams.find((t: any) => t.id === team.id).nodes[0].roleSlug, 'test-reviewer');
    const saved: any = await host.harness.callRpc('roles_list');
    assert.equal(saved.roles.find((r: any) => r.id === role.id).reasoningLevel, 'high');
    for (const reasoningLevel of ['high', 'adaptive', 'provider/effort-v2', null]) {
      await host.harness.callRpc('roles_update', { ...roleInput, id: role.id, reasoningLevel });
      host = await host.harness.reload(plugin);
      const listed: any = await host.harness.callRpc('roles_list');
      assert.equal(listed.roles.find((r: any) => r.id === role.id).reasoningLevel, reasoningLevel);
      await host.harness.callRpc('role_spawn', { roleSlug: 'test-reviewer', prompt: 'Review', projectId: 'project-test' });
      assert.equal(spawns.at(-1)!.reasoningLevel, reasoningLevel ?? undefined);
      assert.equal(spawns.at(-1)!.providerId, 'codex');
      assert.equal(spawns.at(-1)!.model, 'test-model');
    }
    for (const reasoningLevel of ['', 'high --full', 'high;echo', '$(echo)', '`echo`', 'high\n', 'x'.repeat(201)]) {
      await assert.rejects(host.harness.callRpc('roles_update', { ...roleInput, id: role.id, reasoningLevel }));
      await assert.rejects(host.harness.callRpc('roles_create', { ...roleInput, slug: 'unsafe', reasoningLevel }));
    }
    assert.equal(spawns.length, 4);
  } finally { await host.harness.dispose(); }
});

test('agent file sync preserves legacy and custom reasoning values and rejects unsafe tokens', () => {
  for (const reasoningLevel of ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode', 'adaptive', null]) {
    const canon = { ...roleInput, description: '', permissionMode: null, color: 'gray' as const, reasoningLevel };
    assert.equal(parseAgentFile(canon.slug, serializeAgentFile(canon, null), 1).canon.reasoningLevel, reasoningLevel);
  }
  const invalid = '---\nname: reviewer\nbb:\n  reasoning: high;echo\n---\nReview.';
  assert.equal(parseAgentFile('test-reviewer', invalid, 1).canon.reasoningLevel, null);
});
