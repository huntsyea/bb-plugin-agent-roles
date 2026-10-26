// A thread's role (fork, BBP-60): which role a thread has, and the briefing it
// receives. Every reader goes through this module: bb.agents.configure (the
// injected instructions), the thread_role RPC (the header badge), the job
// report on thread.idle and the CLI's warning about cut-off instructions.
// Role Picker keeps a copy of the metadata half (plugins/role-picker/
// role-metadata.ts; bb builds each plugin from its own folder only), and its
// role-metadata.test.ts fails if the copy drifts from this file.

/** This plugin's thread metadata, as spawnRole seeds it and Role Picker sets it. */
export type RoleMetadata = {
  roleId: string;
  roleSlug: string;
  roleName: string;
  roleColor: string;
  taskKey?: string | null;
};

/**
 * The metadata for a thread with `role`, or for a thread whose role was
 * cleared (`null`): every role key is then the empty string, which outranks
 * whatever role the thread was spawned with.
 */
export function roleMetadata(role: { id: string; slug: string; name: string; color: string } | null, taskKey?: string | null): RoleMetadata {
  const keys = role ? { roleId: role.id, roleSlug: role.slug, roleName: role.name, roleColor: role.color } : { roleId: "", roleSlug: "", roleName: "", roleColor: "" };
  return taskKey === undefined ? keys : { ...keys, taskKey };
}

/** The role slug the metadata states: a slug, "" when cleared, undefined when it says nothing. */
export function metadataRoleSlug(metadata: { readonly [key: string]: unknown }): string | undefined {
  return typeof metadata.roleSlug === "string" ? metadata.roleSlug : undefined;
}

/** Instructions bb injects are cut at 4,096 characters; keep the briefing under that. */
export const INSTRUCTION_BUDGET = 3900;

export interface BriefedRole { slug: string; name: string; description: string; instructions: string }

export interface Briefing {
  /** What the thread receives: the role header, then its instructions, cut to the budget. */
  text: string;
  /** Characters of instructions that fit after the header. */
  room: number;
  truncated: boolean;
}

/** The hidden instructions a role thread receives. */
export function roleBriefing(role: BriefedRole, taskKey: string | null): Briefing {
  const head = [
    `# Your role: ${role.name}`,
    role.description ? role.description : "",
    "",
    `Begin your first reply with this exact line so BB renders your role card: ::agent-role{slug="${role.slug}"}`,
    taskKey ? `You are working on task ${taskKey}. Read it with \`bb tasks show ${taskKey}\`; your final answer is posted there as a comment automatically.` : "",
    "",
  ].join("\n");
  const room = INSTRUCTION_BUDGET - head.length;
  const truncated = role.instructions.length > room;
  const body = truncated ? role.instructions.slice(0, room - 20) + "\n[…truncated]" : role.instructions;
  return { text: head + body, room, truncated };
}

export interface ThreadRole<R> {
  /** Null when the thread has no role, or Role Picker cleared it. */
  role: R | null;
  taskKey: string | null;
}

export interface ThreadRolesDeps<R> {
  roleBySlug(slug: string): R | null;
  /** The role_threads row for a thread this plugin spawned. */
  spawned(threadId: string): { roleSlug: string; taskKey: string | null } | null;
  /** This plugin's metadata for a thread ({} when none). */
  metadata(threadId: string): Promise<{ readonly [key: string]: unknown }>;
}

/**
 * Resolve a thread's role. Metadata wins over the role the thread was spawned
 * with, because Role Picker changes and clears roles only there; an empty slug
 * means cleared. The task key resolves the same way, independently of the role.
 */
export function makeThreadRoles<R>(deps: ThreadRolesDeps<R>) {
  function resolve(threadId: string, metadata: { readonly [key: string]: unknown }): ThreadRole<R> {
    const row = deps.spawned(threadId);
    const slug = metadataRoleSlug(metadata) ?? row?.roleSlug ?? "";
    const taskKey = typeof metadata.taskKey === "string" ? metadata.taskKey || null : row?.taskKey ?? null;
    return { role: slug ? deps.roleBySlug(slug) : null, taskKey };
  }
  return {
    /** With the thread's metadata in hand (bb.agents.configure). */
    resolve,
    /** Fetching the metadata; a thread whose metadata can't be read falls back to how it was spawned. */
    async lookup(threadId: string): Promise<ThreadRole<R>> {
      let metadata: { readonly [key: string]: unknown } = {};
      try { metadata = await deps.metadata(threadId); } catch { /* not readable: use the spawn record */ }
      return resolve(threadId, metadata);
    },
  };
}
