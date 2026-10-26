import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Resolve the backend's bundler imports (./name → ./name.ts) when running source with Node.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(import.meta.url.slice(0, import.meta.url.lastIndexOf('/') + 1)) && /^\.\/[\w-]+$/.test(specifier)) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
} });
const { makeRoleJobs } = await import('./role-jobs.ts');
const { memoryTasks } = await import('./memory-tasks.ts');

const ROLES = [{ slug: 'reviewer', name: 'Reviewer' }, { slug: 'analyst', name: 'Analyst' }];
function jobsWith(tasks = memoryTasks(), configuredProject = '') {
  const spawns: Array<Record<string, any>> = [];
  const threads = new Map<string, { roleSlug: string; taskKey: string | null; lastReportHash: string | null }>();
  const jobs = makeRoleJobs({
    run: tasks.run,
    configuredProject: async () => configuredProject,
    roles: { find: (ref: string) => ROLES.find((r) => r.slug === ref) ?? null, list: () => ROLES },
    spawn: async (input: Record<string, any>) => {
      spawns.push(input);
      const threadId = `thread-${spawns.length}`;
      threads.set(threadId, { roleSlug: input.roleSlug, taskKey: input.taskKey, lastReportHash: null });
      return threadId;
    },
    threads: {
      get: async (threadId: string) => {
        const t = threads.get(threadId);
        return t ? { roleName: ROLES.find((r) => r.slug === t.roleSlug)?.name ?? null, taskKey: t.taskKey, lastReportHash: t.lastReportHash } : null;
      },
      forTask: (key: string) => [...threads].filter(([, t]) => t.taskKey === key).map(([id]) => id),
      setReportHash: (threadId: string, hash: string) => { threads.get(threadId)!.lastReportHash = hash; },
    },
    log: { warn: () => undefined },
  });
  return { jobs, tasks, spawns, threads };
}

test('filing a job creates a role-labelled task in the first Tasks project, creating the label once', async () => {
  const { jobs, tasks } = jobsWith();
  const first = await jobs.file('reviewer', '\n  Review the diff\nin HEAD~1', null);
  await jobs.file('reviewer', 'Again', null);
  assert.deepEqual(first, { key: 'AG-1', title: '[Reviewer] Review the diff' });
  assert.deepEqual(tasks.tasks[0]!.labels, ['role:reviewer']);
  assert.equal(tasks.tasks[0]!.description, '\n  Review the diff\nin HEAD~1');
  assert.deepEqual(tasks.labels.get('AG'), ['role:reviewer']);
  await assert.rejects(jobs.file('nobody', 'x', null), /No role "nobody"/);
});

test('filing uses the explicit project, else the configured one', async () => {
  const configured = jobsWith(memoryTasks(), 'OT');
  assert.equal((await configured.jobs.file('analyst', 'Plan it', null)).key, 'OT-1');
  assert.equal((await configured.jobs.file('analyst', 'Plan it', 'AG')).key, 'AG-2');
});

test('listing open role jobs reads Tasks once, however many jobs there are', async () => {
  const { jobs, tasks, threads } = jobsWith(memoryTasks(), 'AG');
  for (let i = 0; i < 5; i++) await jobs.file(i % 2 ? 'analyst' : 'reviewer', `Job ${i}`, null);
  await tasks.run(['create', '--project', 'AG', '--title', 'Not a role job', '--description', '']);
  await tasks.run(['create', '--project', 'AG', '--title', '[Ghost] old role', '--description', '', '--label', 'role:ghost']);
  tasks.tasks[4]!.status = 'done';
  threads.set('thread-a', { roleSlug: 'reviewer', taskKey: 'AG-1', lastReportHash: null });
  threads.set('thread-b', { roleSlug: 'reviewer', taskKey: 'AG-1', lastReportHash: null });
  tasks.calls.length = 0;
  const listed = await jobs.list();
  assert.equal(listed.project, 'AG');
  assert.deepEqual(listed.tasks.map((t) => [t.key, t.roleSlug, t.threadIds]), [
    ['AG-1', 'reviewer', ['thread-a', 'thread-b']], ['AG-2', 'analyst', []], ['AG-3', 'reviewer', []], ['AG-4', 'analyst', []],
  ]);
  assert.deepEqual(tasks.calls.map((c) => c[0]), ['list']);
});

test('listing without any Tasks project is empty, not an error', async () => {
  const empty = memoryTasks();
  const { jobs } = jobsWith({ ...empty, run: async (args) => (args[0] === 'project' ? { projects: [] } : empty.run(args)) });
  assert.deepEqual(await jobs.list(), { tasks: [], project: null });
});

test('opening a job spawns its role thread where the placement says, attaches it and starts the task', async () => {
  const { jobs, tasks, spawns } = jobsWith(memoryTasks(), 'AG');
  await jobs.file('reviewer', '  Review the diff  ', null);
  const placement = { callerThreadId: 'caller', environmentId: null, machine: 'mini' };
  const threadId = await jobs.open({ taskKey: 'AG-1', projectId: 'proj_x', placement, parentThreadId: 'parent' });
  assert.equal(threadId, 'thread-1');
  assert.deepEqual(spawns[0], { roleSlug: 'reviewer', prompt: 'Review the diff', projectId: 'proj_x', placement, parentThreadId: 'parent', hidden: false, taskKey: 'AG-1' });
  assert.deepEqual(tasks.attached.get('AG-1'), ['thread-1']);
  assert.equal(tasks.tasks[0]!.status, 'in_progress');
  tasks.tasks[0]!.status = 'in_review';
  await jobs.open({ taskKey: 'AG-1', projectId: 'proj_x', placement, parentThreadId: null });
  assert.equal(tasks.tasks[0]!.status, 'in_review', 'only backlog and todo jobs move to in progress');
  await tasks.run(['create', '--project', 'AG', '--title', 'Plain task', '--description', '']);
  await assert.rejects(jobs.open({ taskKey: 'AG-2', projectId: 'proj_x', placement, parentThreadId: null }), /no role label/);
});

test('a job with no description opens with its title as the prompt', async () => {
  const { jobs, tasks, spawns } = jobsWith(memoryTasks(), 'AG');
  await tasks.run(['create', '--project', 'AG', '--title', '[Analyst] Plan it', '--description', '', '--label', 'role:analyst']);
  await jobs.open({ taskKey: 'AG-1', projectId: 'proj_x', placement: { callerThreadId: null }, parentThreadId: null });
  assert.equal(spawns[0]!.prompt, '[Analyst] Plan it');
});

test('a role thread\'s answer is posted to its job once, without the role card, truncated when long', async () => {
  const { jobs, tasks, threads } = jobsWith(memoryTasks(), 'AG');
  const { key } = await jobs.file('reviewer', 'Review', null);
  const threadId = await jobs.open({ taskKey: key, projectId: 'proj_x', placement: { callerThreadId: null }, parentThreadId: null });
  await jobs.report(threadId, '::agent-role{slug="reviewer"}\nLooks good.');
  await jobs.report(threadId, '::agent-role{slug="reviewer"}\nLooks good.');
  assert.deepEqual(tasks.comments, [{ key, body: `**Reviewer** (thread ${threadId}):\n\nLooks good.` }]);
  await jobs.report(threadId, 'x'.repeat(7000));
  assert.equal(tasks.comments[1]!.body, `**Reviewer** (thread ${threadId}):\n\n${'x'.repeat(6000)}\n\n[…truncated; full answer in the thread]`);
  // Nothing to post: a thread without a job, an unknown thread, or only the role card.
  threads.set('loose', { roleSlug: 'reviewer', taskKey: null, lastReportHash: null });
  await jobs.report('loose', 'Answer');
  await jobs.report('unknown', 'Answer');
  await jobs.report(threadId, '::agent-role{slug="reviewer"}\n');
  assert.equal(tasks.comments.length, 2);
});

test('a failed report is retried on the next idle', async () => {
  const memory = memoryTasks();
  let down = true;
  const { jobs } = jobsWith({ ...memory, run: async (args) => { if (down && args[0] === 'comment') throw new Error('Tasks unavailable'); return memory.run(args); } }, 'AG');
  const { key } = await jobs.file('reviewer', 'Review', null);
  const threadId = await jobs.open({ taskKey: key, projectId: 'proj_x', placement: { callerThreadId: null }, parentThreadId: null });
  await jobs.report(threadId, 'Done.');
  down = false;
  await jobs.report(threadId, 'Done.');
  assert.equal(memory.comments.length, 1);
});
