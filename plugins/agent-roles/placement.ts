// Where a role thread runs (fork, BBP-48). Every spawn path (the `bb role` CLI,
// the Agent roles page, role jobs and team-run steps) hands spawnRole a
// placement request; this module turns it into the SDK's thread-spawn
// environment, so they all follow one rule:
//
// 1. An explicit environment, or an explicit machine (that machine's project
//    checkout). Naming both is an error.
// 2. The calling thread's environment, when that thread is in the same project.
// 3. The caller's machine when the project has a local checkout there, else the
//    project's only machine with a local checkout.
// 4. bb's project default. It resolves on the bb server's machine, because the
//    plugin calls bb from there.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export interface PlacementRequest {
  /** The thread the request came from; its environment and machine inform the default. */
  callerThreadId: string | null;
  environmentId?: string | null;
  /** Machine ID or exact, unique machine name. */
  machine?: string | null;
}

/** The subset of the SDK's thread-spawn environment args a role thread uses. */
export type RoleThreadEnvironment =
  | { type: "reuse"; environmentId: string }
  | { type: "host"; hostId: string; workspace: { type: "unmanaged"; path: null } }
  | { type: "project-default" };

type Sdk = Pick<BbPluginApi["sdk"], "threads" | "environments" | "projects" | "hosts">;

export function makePlacement(sdk: Sdk) {
  /** A machine selector is an exact host ID or an exact, unique machine name. */
  async function resolveHostId(selector: string): Promise<string> {
    const hosts = await sdk.hosts.list();
    const byId = hosts.find((h) => h.id === selector);
    if (byId) return byId.id;
    const byName = hosts.filter((h) => h.name === selector);
    if (byName.length === 1) return byName[0]!.id;
    const known = hosts.map((h) => `${h.name} (${h.id})`).join(", ");
    throw new Error(byName.length ? `Machine name "${selector}" is ambiguous; use its ID: ${known}` : `No machine "${selector}". Machines: ${known}`);
  }

  async function caller(threadId: string | null): Promise<{ projectId: string; environmentId: string | null; hostId: string | null } | null> {
    if (!threadId) return null;
    try {
      const t = await sdk.threads.get({ threadId });
      const environmentId = t.environmentId ?? null;
      return { projectId: t.projectId, environmentId, hostId: environmentId ? await hostOf(environmentId) : null };
    } catch {
      return null; // thread gone
    }
  }

  async function hostOf(environmentId: string): Promise<string | null> {
    try { return (await sdk.environments.get({ environmentId })).hostId; } catch { return null; }
  }

  /** Machines where the project has a local checkout. */
  async function checkoutHosts(projectId: string): Promise<string[]> {
    let sources: Array<{ type: string; hostId?: string | null }> = [];
    try { sources = (await sdk.projects.get({ projectId })).sources ?? []; } catch { /* unknown project: no checkouts */ }
    return [...new Set(sources.flatMap((s) => (s.type === "local_path" && s.hostId ? [s.hostId] : [])))];
  }

  const onHost = (hostId: string): RoleThreadEnvironment => ({ type: "host", hostId, workspace: { type: "unmanaged", path: null } });

  return async function place(projectId: string, request: PlacementRequest): Promise<RoleThreadEnvironment> {
    if (request.environmentId && request.machine) throw new Error("Pass --environment or --machine, not both.");
    if (request.environmentId) return { type: "reuse", environmentId: request.environmentId };
    if (request.machine) return onHost(await resolveHostId(request.machine));
    const from = await caller(request.callerThreadId);
    if (from && from.projectId === projectId && from.environmentId) return { type: "reuse", environmentId: from.environmentId };
    const hosts = await checkoutHosts(projectId);
    if (from?.hostId && hosts.includes(from.hostId)) return onHost(from.hostId);
    return hosts.length === 1 ? onHost(hosts[0]!) : { type: "project-default" };
  };
}
