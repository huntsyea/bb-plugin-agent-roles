// Test adapter: an in-memory stand-in for the `bb tasks … --json` runner
// (tasks-cli.ts is the production one). Used by the tests only.
/** Just enough of the Tasks CLI for role jobs. */
export function memoryTasks() {
  const calls: string[][] = [];
  const projects = [{ id: 'tp_1', name: 'Agents', prefix: 'AG', linkedBbProjectId: null }, { id: 'tp_2', name: 'Other', prefix: 'OT', linkedBbProjectId: null }];
  const labels = new Map<string, string[]>();
  const tasks: Array<Record<string, any>> = [];
  const attached = new Map<string, string[]>();
  const comments: Array<{ key: string; body: string }> = [];
  const flag = (args: string[], name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1]! : undefined; };
  const flags = (args: string[], name: string) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]!] : []));
  const find = (key: string) => { const t = tasks.find((x) => x.key === key); if (!t) throw new Error(`No task ${key}`); return t; };
  const run = async (args: string[]): Promise<Record<string, unknown>> => {
    calls.push(args);
    const [command, sub] = args;
    if (command === 'project' && sub === 'list') return { projects };
    if (command === 'label' && sub === 'list') return { labels: (labels.get(flag(args, 'project')!) ?? []).map((name) => ({ name })) };
    if (command === 'label' && sub === 'create') { const p = flag(args, 'project')!; labels.set(p, [...(labels.get(p) ?? []), flag(args, 'name')!]); return {}; }
    if (command === 'create') {
      const project = flag(args, 'project')!;
      const task = { key: `${project}-${tasks.length + 1}`, project, title: flag(args, 'title'), description: flag(args, 'description'), status: 'backlog', priority: 'none', updatedAt: '2026-10-26T00:00:00Z', labels: flags(args, 'label') };
      tasks.push(task);
      return { task };
    }
    if (command === 'list') {
      const statuses = flags(args, 'status');
      return { tasks: tasks.filter((t) => t.project === flag(args, 'project') && (!statuses.length || statuses.includes(t.status))) };
    }
    if (command === 'show') { const t = find(sub!); return { task: t, labels: t.labels.map((name: string) => ({ id: name, name })), taskThreads: (attached.get(t.key) ?? []).map((threadId) => ({ threadId })) }; }
    if (command === 'attach') { find(sub!); attached.set(sub!, [...(attached.get(sub!) ?? []), flag(args, 'thread')!]); return {}; }
    if (command === 'update') { find(sub!).status = flag(args, 'status'); return {}; }
    if (command === 'comment') { find(sub!); comments.push({ key: sub!, body: flag(args, 'body')! }); return {}; }
    throw new Error(`unexpected bb tasks ${args.join(' ')}`);
  };
  return { run, calls, tasks, labels, attached, comments };
}
