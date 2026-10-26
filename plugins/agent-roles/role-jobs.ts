// Role jobs: a Tasks record filed for a role, with no thread until someone
// opens a chat from it (BBP-49). This module files, lists and opens jobs and
// posts a role thread's answer back to its job. It reaches the builtin Tasks
// plugin only through a `bb tasks … --json` runner: tasks-cli.ts runs the real
// CLI; tests use an in-memory one.
import type { BbTasksRunner } from "./tasks-cli";
import type { PlacementRequest } from "./placement";

export const ROLE_LABEL_PREFIX = "role:";

export interface TasksProject { id: string; name: string; prefix: string; linkedBbProjectId: string | null }
export interface TaskRecord {
  key: string; title: string; description: string; status: string; priority: string; updatedAt: string;
  /** Label names, as `bb tasks list` returns them. */
  labels?: string[];
}
interface TaskDetail {
  task: TaskRecord;
  labels: Array<{ id: string; name: string }>;
}

export interface RoleJob {
  key: string; title: string; description: string; status: string; priority: string; roleSlug: string | null; updatedAt: string;
  /** Threads opened for this job, oldest first. */
  threadIds: string[];
}

export interface RoleJobsDeps {
  run: BbTasksRunner;
  /** The Tasks project setting (prefix or id); empty means the first Tasks project. */
  configuredProject: () => Promise<string>;
  roles: { find(ref: string): { slug: string; name: string } | null; list(): Array<{ slug: string; name: string }> };
  /** Spawn the role thread (server.ts spawnRole); it records the thread with its task key. */
  spawn(input: { roleSlug: string; prompt: string; projectId: string; placement: PlacementRequest; parentThreadId: string | null; hidden: false; taskKey: string }): Promise<string>;
  /** Role threads this plugin spawned (the role_threads table). */
  threads: {
    get(threadId: string): { roleSlug: string; taskKey: string | null; lastReportHash: string | null } | null;
    forTask(taskKey: string): string[];
    setReportHash(threadId: string, hash: string): void;
  };
  log: { warn(message: string): void };
}

const OPEN_STATUSES = ["backlog", "todo", "in_progress", "in_review"];
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const roleSlugOf = (labelNames: string[]) =>
  labelNames.find((n) => n.startsWith(ROLE_LABEL_PREFIX))?.slice(ROLE_LABEL_PREFIX.length) ?? null;

export function makeRoleJobs(deps: RoleJobsDeps) {
  const { run } = deps;
  const knownLabels = new Map<string, Set<string>>();

  async function projectOf(explicit: string | null): Promise<string> {
    if (explicit) return explicit;
    const configured = (await deps.configuredProject()).trim();
    if (configured) return configured;
    const projects = ((await run(["project", "list"])).projects as TasksProject[] | undefined) ?? [];
    if (!projects.length) throw new Error("No Tasks project exists yet. Create one in Tasks or run: bb tasks project create");
    return projects[0]!.prefix;
  }

  /** Create the `role:<slug>` label once per project. */
  async function ensureLabel(project: string, name: string): Promise<void> {
    let known = knownLabels.get(project);
    if (!known) {
      const labels = ((await run(["label", "list", "--project", project])).labels as Array<{ name: string }> | undefined) ?? [];
      known = new Set(labels.map((l) => l.name.toLowerCase()));
      knownLabels.set(project, known);
    }
    if (known.has(name.toLowerCase())) return;
    await run(["label", "create", "--project", project, "--name", name]);
    known.add(name.toLowerCase());
  }

  return {
    /** File the request as a Tasks record labelled with the role; no thread yet. */
    async file(roleRef: string, prompt: string, project: string | null): Promise<{ key: string; title: string }> {
      const role = deps.roles.find(roleRef);
      if (!role) throw new Error(`No role "${roleRef}". Run "bb role list".`);
      const proj = await projectOf(project);
      const label = ROLE_LABEL_PREFIX + role.slug;
      await ensureLabel(proj, label);
      const firstLine = prompt.split("\n").find((l) => l.trim())?.trim() ?? prompt;
      const title = `[${role.name}] ${firstLine.slice(0, 100)}`;
      const task = (await run(["create", "--project", proj, "--title", title, "--description", prompt, "--label", label])).task as TaskRecord;
      return { key: task.key, title: task.title };
    },

    /** Open jobs for existing roles, from one `bb tasks list`; their threads come from role_threads. */
    async list(): Promise<{ tasks: RoleJob[]; project: string | null }> {
      let project: string;
      try { project = await projectOf(null); } catch { return { tasks: [], project: null }; }
      const slugs = new Set(deps.roles.list().map((r) => r.slug));
      const args = ["list", "--project", project];
      for (const status of OPEN_STATUSES) args.push("--status", status);
      args.push("--limit", "200");
      const rows = ((await run(args)).tasks as TaskRecord[] | undefined) ?? [];
      return {
        project,
        tasks: rows.flatMap((t) => {
          const slug = roleSlugOf(t.labels ?? []);
          if (!slug || !slugs.has(slug)) return [];
          return [{ key: t.key, title: t.title, description: t.description ?? "", status: t.status, priority: t.priority, roleSlug: slug, updatedAt: t.updatedAt, threadIds: deps.threads.forTask(t.key) }];
        }),
      };
    },

    /** Open a thread for a job's role, attach it and mark the job in progress. */
    async open(input: { taskKey: string; projectId: string; placement: PlacementRequest; parentThreadId: string | null }): Promise<string> {
      const detail = (await run(["show", input.taskKey])) as unknown as TaskDetail;
      const slug = roleSlugOf((detail.labels ?? []).map((l) => l.name));
      if (!slug) throw new Error(`Task ${input.taskKey} has no role label (${ROLE_LABEL_PREFIX}<slug>).`);
      const prompt = detail.task.description?.trim() || detail.task.title;
      const threadId = await deps.spawn({ roleSlug: slug, prompt, projectId: input.projectId, placement: input.placement, parentThreadId: input.parentThreadId, hidden: false, taskKey: detail.task.key });
      try { await run(["attach", detail.task.key, "--thread", threadId]); } catch (cause) { deps.log.warn(`attach ${detail.task.key}: ${message(cause)}`); }
      if (detail.task.status === "backlog" || detail.task.status === "todo") {
        try { await run(["update", detail.task.key, "--status", "in_progress"]); } catch { /* status is cosmetic */ }
      }
      return threadId;
    },

    /** Post a role thread's latest answer to its job as one comment; the same answer is posted once. */
    async report(threadId: string, answer: string): Promise<void> {
      const row = deps.threads.get(threadId);
      if (!row?.taskKey) return;
      const text = answer.replace(/^::agent-role\{[^}]*\}\s*$/m, "").trim();
      if (!text) return;
      const hash = String(text.length) + ":" + text.slice(0, 64);
      if (row.lastReportHash === hash) return;
      try {
        const body = text.length > 6000 ? text.slice(0, 6000) + "\n\n[…truncated; full answer in the thread]" : text;
        await run(["comment", row.taskKey, "--body", `**${deps.roles.find(row.roleSlug)?.name ?? row.roleSlug}** (thread ${threadId}):\n\n${body}`]);
        deps.threads.setReportHash(threadId, hash);
      } catch (cause) {
        deps.log.warn(`report to ${row.taskKey}: ${message(cause)}`);
      }
    },
  };
}
export type RoleJobs = ReturnType<typeof makeRoleJobs>;
