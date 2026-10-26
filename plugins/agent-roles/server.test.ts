import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';

// Resolve the backend's bundler imports when running source with Node.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(import.meta.url.slice(0, import.meta.url.lastIndexOf('/') + 1)) &&
      /^\.\/[\w-]+$/.test(specifier)) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
} });
const { default: plugin, agentRoles } = await import('./server.ts');
const { memoryTasks } = await import('./memory-tasks.ts');
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

// Where role threads run (BBP-45, BBP-48). Machines: mac (the bb server),
// mini and g5. proj_mini has its only checkout on mini; proj_two has checkouts
// on mac and mini; caller threads sit in proj_mini or in proj_other.
const onHost = (hostId: string) => ({ type: 'host', hostId, workspace: { type: 'unmanaged', path: null } });
const MINI_ONLY = onHost('host_mini');
const THREADS: Record<string, { projectId: string; environmentId: string | null }> = {
  'caller-same': { projectId: 'proj_mini', environmentId: 'env_same' },
  'caller-g5': { projectId: 'proj_other', environmentId: 'env_g5' },
  'caller-mini': { projectId: 'proj_other', environmentId: 'env_mini' },
};
const ENV_HOSTS: Record<string, string> = { env_same: 'host_mini', env_g5: 'host_g5', env_mini: 'host_mini' };
const SOURCES: Record<string, Array<{ type: string; hostId: string }>> = {
  proj_mini: [{ type: 'local_path', hostId: 'host_mini' }],
  proj_two: [{ type: 'local_path', hostId: 'host_mac' }, { type: 'local_path', hostId: 'host_mini' }],
};
function placementHost() {
  const spawns: Array<Record<string, any>> = [];
  const host = createFakePluginHost({ pluginId: 'agent-roles', settings: { syncEnabled: false },
    sdk: {
      threads: {
        spawn: (args: any) => { spawns.push(args); return { id: `thread-${spawns.length}` }; },
        get: ({ threadId }: any) => {
          const t = THREADS[threadId];
          if (!t) throw new Error(`no thread ${threadId}`);
          return { id: threadId, status: 'active', ...t };
        },
      },
      environments: { get: ({ environmentId }: any) => ({ id: environmentId, hostId: ENV_HOSTS[environmentId] }) },
      projects: { get: ({ projectId }: any) => ({ id: projectId, sources: SOURCES[projectId] ?? [] }) },
      hosts: { list: () => [{ id: 'host_mac', name: 'mac' }, { id: 'host_mini', name: 'mini' }, { id: 'host_g5', name: 'g5' }, { id: 'host_g5b', name: 'g5' }] },
    } as any,
  });
  return { host, spawns };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 10)); }
  assert.fail('timed out');
}
/** Cancel team runs and let them settle, so nothing touches the host after dispose. */
async function settleRuns(host: ReturnType<typeof createFakePluginHost>) {
  const { runs }: any = await host.harness.callRpc('runs_list', null);
  for (const r of runs) if (r.status === 'running') await host.harness.callRpc('runs_cancel', { id: r.id });
  await until(async () => ((await host.harness.callRpc('runs_list', null)) as any).runs.every((r: any) => r.status !== 'running'));
}

test('the page\'s Chat now runs the role thread on the project\'s only checkout, not the bb server\'s machine', async () => {
  const { host, spawns } = placementHost();
  try {
    await plugin(host.bb);
    await host.harness.callRpc('role_spawn', { roleSlug: 'reviewer', prompt: 'Review', projectId: 'proj_mini', environmentId: null, parentThreadId: null, hidden: false, taskKey: null });
    assert.deepEqual(spawns.at(-1)!.environment, MINI_ONLY);
  } finally { await host.harness.dispose(); }
});

test('a team run started from the page runs its steps on the project\'s only checkout', async () => {
  const { host, spawns } = placementHost();
  try {
    await plugin(host.bb);
    await host.harness.callRpc('runs_start', { teamSlug: 'feature', task: 'Add a flag', projectId: 'proj_mini' });
    await until(() => spawns.length > 0);
    assert.deepEqual(spawns[0]!.environment, MINI_ONLY);
    await settleRuns(host);
  } finally { await host.harness.dispose(); }
});

test('bb role run keeps the machine it resolves, and takes --machine', async () => {
  const { host, spawns } = placementHost();
  try {
    await plugin(host.bb);
    const fromOtherProject = await host.harness.runCli(['run', 'feature', '--task', 'Add a flag', '--project', 'proj_mini'], { threadId: 'caller-g5' });
    assert.equal(fromOtherProject.exitCode, 0, fromOtherProject.stderr);
    await until(() => spawns.length === 1);
    assert.deepEqual(spawns[0]!.environment, MINI_ONLY);
    const onMachine = await host.harness.runCli(['run', 'feature', '--task', 'Add a flag', '--project', 'proj_two', '--machine', 'mac'], { threadId: 'caller-g5' });
    assert.equal(onMachine.exitCode, 0, onMachine.stderr);
    await until(() => spawns.length === 2);
    assert.deepEqual(spawns[1]!.environment, onHost('host_mac'));
    const bad = await host.harness.runCli(['run', 'feature', '--task', 'Add a flag', '--project', 'proj_two', '--machine', 'nowhere']);
    assert.equal(bad.exitCode, 1);
    assert.match(bad.stderr!, /No machine "nowhere"/);
    const runs: any = await host.harness.callRpc('runs_list', null);
    assert.equal(runs.runs.length, 2, 'a bad machine fails before the run exists');
    await settleRuns(host);
  } finally { await host.harness.dispose(); }
});

test('bb role spawn --thread places the role thread by the one rule', async () => {
  const { host, spawns } = placementHost();
  const spawn = async (ctx: Record<string, string>, ...flags: string[]) => {
    const result = await host.harness.runCli(['spawn', 'reviewer', '--prompt', 'Review', '--thread', ...flags], ctx);
    return result.exitCode === 0 ? spawns.at(-1)!.environment : result.stderr;
  };
  try {
    await plugin(host.bb);
    // The caller's environment carries over within its own project only.
    assert.deepEqual(await spawn({ threadId: 'caller-same' }), { type: 'reuse', environmentId: 'env_same' });
    // Another project: the caller's machine when the project has a checkout there, else its only checkout.
    assert.deepEqual(await spawn({ threadId: 'caller-mini' }, '--project', 'proj_two'), onHost('host_mini'));
    assert.deepEqual(await spawn({ threadId: 'caller-g5' }, '--project', 'proj_mini'), MINI_ONLY);
    assert.deepEqual(await spawn({ threadId: 'caller-g5' }, '--project', 'proj_two'), { type: 'project-default' });
    assert.deepEqual(await spawn({}, '--project', 'proj_unknown'), { type: 'project-default' });
    // Explicit choices win over the caller.
    assert.deepEqual(await spawn({ threadId: 'caller-same' }, '--environment', 'env_x'), { type: 'reuse', environmentId: 'env_x' });
    assert.deepEqual(await spawn({ threadId: 'caller-same' }, '--machine', 'mac'), onHost('host_mac'));
    assert.deepEqual(await spawn({ threadId: 'caller-same' }, '--machine', 'host_g5'), onHost('host_g5'));
    assert.match(await spawn({ threadId: 'caller-same' }, '--machine', 'g5'), /ambiguous/);
    assert.match(await spawn({ threadId: 'caller-same' }, '--machine', 'mac', '--environment', 'env_x'), /not both/);
  } finally { await host.harness.dispose(); }
});

test('opening a role job from the page places its thread by the same rule', async () => {
  const { host, spawns } = placementHost();
  const tasks = memoryTasks();
  try {
    await agentRoles(host.bb, { tasksRunner: tasks.run });
    const job: any = await host.harness.callRpc('role_task_create', { roleSlug: 'reviewer', prompt: 'Review the diff', project: 'AG' });
    const { threadId }: any = await host.harness.callRpc('role_chat', { taskKey: job.key, projectId: 'proj_mini', callerThreadId: 'caller-g5', parentThreadId: null });
    assert.deepEqual(spawns.at(-1)!.environment, MINI_ONLY);
    assert.deepEqual(tasks.attached.get(job.key), [threadId]);
    const listed: any = await host.harness.callRpc('role_tasks_list', null);
    assert.deepEqual(listed.tasks.map((t: any) => [t.key, t.threadIds]), [[job.key, [threadId]]]);
    const cli = await host.harness.runCli(['chat', job.key, '--machine', 'mac'], { threadId: 'caller-same' });
    assert.equal(cli.exitCode, 0, cli.stderr);
    assert.deepEqual(spawns.at(-1)!.environment, onHost('host_mac'));
    await host.harness.emitThreadEvent('thread.idle', { thread: { id: threadId }, lastAssistantText: 'Looks good.' } as any);
    assert.deepEqual(tasks.comments, [{ key: job.key, body: `**Reviewer** (thread ${threadId}):\n\nLooks good.` }]);
  } finally { await host.harness.dispose(); }
});

// A thread's role (BBP-46, BBP-60). Role Picker writes this plugin's thread
// metadata; the badge, the injected instructions and job reports must agree.
function roleHost() {
  const metadata = new Map<string, Record<string, unknown>>();
  const spawns: Array<Record<string, any>> = [];
  const host = createFakePluginHost({ pluginId: 'agent-roles', settings: { syncEnabled: false }, agentSkillIds: ['agent-roles'],
    sdk: { threads: {
      spawn: (args: any) => { spawns.push(args); const id = `thread-${spawns.length}`; metadata.set(id, { ...args.pluginMetadata }); return { id }; },
      getPluginMetadata: ({ threadId }: any) => metadata.get(threadId) ?? {},
    } } as any,
  });
  /** What Role Picker's prepare writes into this plugin's metadata (a merge). */
  const pick = (threadId: string, set: Record<string, string>) => metadata.set(threadId, { ...metadata.get(threadId), ...set });
  const configure = (threadId: string) => host.harness.resolveAgentConfiguration({
    pluginMetadata: metadata.get(threadId) ?? {}, thread: { id: threadId, title: null, parentThreadId: null, sourceThreadId: null },
    project: { id: 'project-test', kind: 'standard', name: 'Test', gitRemoteUrl: null }, environment: { id: 'env', name: null, path: null },
  } as any);
  return { host, spawns, pick, configure };
}

test('after Role Picker changes or clears a spawned thread\'s role, the badge shows what the thread is told', async () => {
  const { host, pick, configure } = roleHost();
  try {
    await plugin(host.bb);
    const { roles }: any = await host.harness.callRpc('roles_list', null);
    const analyst = roles.find((r: any) => r.slug === 'analyst');
    const spawned = await host.harness.runCli(['spawn', 'reviewer', '--prompt', 'Review', '--thread', '--project', 'project-test']);
    assert.equal(spawned.exitCode, 0, spawned.stderr);
    pick('thread-1', { roleId: analyst.id, roleSlug: 'analyst', roleName: 'Analyst', roleColor: analyst.color });
    assert.match((await configure('thread-1')).instructions ?? '', /# Your role: Analyst/);
    assert.equal(((await host.harness.callRpc('thread_role', { threadId: 'thread-1' })) as any)?.roleSlug, 'analyst');
    pick('thread-1', { roleId: '', roleSlug: '', roleName: '', roleColor: '' });
    assert.equal((await configure('thread-1')).instructions, null);
    assert.equal(await host.harness.callRpc('thread_role', { threadId: 'thread-1' }), null);
  } finally { await host.harness.dispose(); }
});

test('a job report names the role the thread has now', async () => {
  const { host, pick } = roleHost();
  const tasks = memoryTasks();
  try {
    await agentRoles(host.bb, { tasksRunner: tasks.run });
    await tasks.run(['create', '--project', 'AG', '--title', '[Reviewer] Review', '--description', 'Review', '--label', 'role:reviewer']);
    const spawned = await host.harness.runCli(['spawn', 'reviewer', '--prompt', 'Review', '--thread', '--task', 'AG-1', '--project', 'project-test']);
    assert.equal(spawned.exitCode, 0, spawned.stderr);
    pick('thread-1', { roleId: 'x', roleSlug: 'analyst', roleName: 'Analyst', roleColor: 'blue' });
    await host.harness.emitThreadEvent('thread.idle', { thread: { id: 'thread-1' }, lastAssistantText: 'Planned.' } as any);
    pick('thread-1', { roleId: '', roleSlug: '', roleName: '', roleColor: '' });
    await host.harness.emitThreadEvent('thread.idle', { thread: { id: 'thread-1' }, lastAssistantText: 'Done.' } as any);
    assert.deepEqual(tasks.comments.map((c) => c.body), ['**Analyst** (thread thread-1):\n\nPlanned.', '**Agent** (thread thread-1):\n\nDone.']);
  } finally { await host.harness.dispose(); }
});

test('the CLI warns about cut-off instructions exactly when a role thread receives them cut off', async () => {
  const { host, configure } = roleHost();
  const { roleBriefing } = await import('./thread-role.ts');
  try {
    await plugin(host.bb);
    const base = { slug: 'budget', name: 'Budget', description: 'Fills the room.' };
    const { room } = roleBriefing({ ...base, slug: `${base.slug}-0`, instructions: '' }, null); // every slug below is as long
    for (const [i, length] of [room - 1, room, room + 1, room + 500].entries()) {
      const slug = `${base.slug}-${i}`;
      const created = await host.harness.runCli(['create', slug, '--name', base.name, '--description', base.description, '--instructions', 'x'.repeat(length)]);
      assert.equal(created.exitCode, 0, created.stderr);
      const spawned = await host.harness.runCli(['spawn', slug, '--prompt', 'Go', '--thread', '--project', 'project-test']);
      assert.equal(spawned.exitCode, 0, spawned.stderr);
      const threadId = spawned.stdout!.match(/thread (thread-\d+)/)![1]!;
      const injected = (await configure(threadId)).instructions ?? '';
      assert.equal(injected.endsWith('[…truncated]'), length > room, `length ${length}`);
      assert.equal(/cut off/.test(created.stdout!), injected.endsWith('[…truncated]'), `length ${length}`);
    }
  } finally { await host.harness.dispose(); }
});
