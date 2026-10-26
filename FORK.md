# Fork notes

Local fork of [dmitriikapustin/bb-plugins-by-kapustin](https://github.com/dmitriikapustin/bb-plugins-by-kapustin), a monorepo of BB plugins.
`main` is our branch, pushed to `origin` ([huntsyea/bb-plugin-agent-roles](https://github.com/huntsyea/bb-plugin-agent-roles), a GitHub fork of upstream). The local folder and our fork are named for agent-roles, the only plugin we run from here.
The `upstream` remote is fetch-only (push is disabled).

- **Base:** upstream `main` at `agent-roles/v0.1.0`
- **Local checkout:** `/Users/huntsyea/Dev/bb-plugins/bb-plugin-agent-roles` (formerly named `kapustin`).
- **Installed in BB from this fork:** `plugins/agent-roles` (2026-10-20) and `plugins/role-picker` (2026-10-20). `bb plugin list` shows both sources under `/Users/huntsyea/Dev/bb-plugins/bb-plugin-agent-roles/plugins/`.
- **Other installed plugins from upstream Git:** goals and visual-workflows. **my-tasks is not installed.**

## Requirements and install notes — 2026-10-20

All 13 plugin manifests require BB `>=0.43` and Plugin SDK `>=0.4.87`,
consistent with their README requirement lines. The root manifest declares
Node `>=22.18`; upstream READMEs specify Node 22.19+ for development, a
stricter documented prerequisite. Keep that development prerequisite.

The upstream README install examples select upstream packages. The local
agent-roles installation uses this fork's `plugins/agent-roles` directory.
Keep upstream README and AGENTS.md identities intact; this file records the
fork name, origin, and local installation.

## Our changes

| Change | Main files |
|---|---|
| One placement rule for every role thread (BBP-48, fixing BBP-45). `bb role spawn --thread`, `bb role chat`, `bb role run`, the Agent roles page (Chat now, Chat with, Run) and every team-run step hand `spawnRole` a placement request, and `placement.ts` resolves it: an explicit `--environment` or `--machine <id-or-name>` (that machine's project checkout; not both); else the calling thread's environment, only when that thread is in the target project (a call from another project's thread used to fail with `409 Environment belongs to a different project`); else the caller's machine if the project has a local checkout there; else the project's only local checkout; else bb's project default. That default resolves on the bb server's machine because the plugin calls bb from there, which is why `role spawn` 404'd where `thread spawn` worked, and why page spawns and team runs used to land on the bb server's machine. `bb role run` takes `--machine`. The page passes its open thread as the caller. The RPC inputs `role_spawn`, `role_chat` and `runs_start` take `callerThreadId` and `hostId`; `environmentId` with `hostId` is an error. | `placement.ts`; `spawnRole`, `projectFor`, `placementFor` and the RPC handlers in `server.ts`; `SpawnBox`, `RoleJobs`, `RunBox` in `app.tsx`; tests in `server.test.ts` |
| Role jobs are one module (BBP-49): filing (`bb role spawn` without `--thread`), opening (`bb role chat`, Chat with), listing (`bb role tasks`, the page's Jobs list) and posting a role thread's answer to its job. It reaches Tasks only through a `BbTasksRunner`: `tasks-cli.ts` runs `bb tasks … --json`, tests use `memory-tasks.ts`. `sync.ts` is now only about sync. Listing makes one `bb tasks list` call (it used to run `bb tasks show` once per job, up to 200 per page refresh). A job's threads now come from the threads this plugin opened for it (`role_threads`), not from the task's attachments, so a thread attached to a role job by other means no longer shows under Open thread. `server.ts` exports `agentRoles(bb, { tasksRunner })` for tests; the default export is unchanged. | `role-jobs.ts`, `tasks-cli.ts`, `memory-tasks.ts`; wiring in `server.ts`; tests in `role-jobs.test.ts`, `server.test.ts` |
| `bb role create <slug>` and `bb role update <role>` create and edit roles from the CLI, through the same validation as the Agent roles page. `--instructions-file` reads a file on the bb server's machine; `inherit` clears provider, model, reasoning or permission. Both report when instructions exceed what a role thread receives (about 3,700 characters after the role header), because bb otherwise truncates them silently. Teams are still edited only on the page, and there is no CLI delete. | `create`/`update` cases and `roleFieldsFrom`, `roomNote` in `server.ts`; the briefing budget in `thread-role.ts` (shared with `bb.agents.configure`) |
| One module owns a thread's role (BBP-60, fixing BBP-46): `thread-role.ts` holds this plugin's thread-metadata keys (`roleId`, `roleSlug`, `roleName`, `roleColor`, `taskKey`), one precedence (the metadata, where Role Picker changes and clears roles, then the role the thread was spawned with in `role_threads`), clearing (an empty `roleSlug` means no role) and the briefing (header, 3,900-character budget, truncation). `bb.agents.configure`, the `thread_role` RPC (header badge), the job report on `thread.idle` and the CLI's cut-off warning all go through it. Before, the badge read `role_threads` first, so after Role Picker changed or cleared a spawned thread's role the badge kept the old role while the thread got the new instructions. A job report now names the thread's current role (`**Agent**` when cleared). Role Picker's `prepare` and `current` import `roleMetadata` and `metadataRoleSlug` from `../agent-roles/thread-role.ts`; `bb plugin build` inlines it, so Role Picker must be built from this monorepo. Metadata keys and table shape are unchanged. Mostly upstream-owned lines. | `thread-role.ts`; `configure`, `thread_role`, `roomNote`, `spawnRole` metadata and the role-jobs wiring in `server.ts`; `report` in `role-jobs.ts`; `prepare`/`current` in `plugins/role-picker/server.ts`; tests in `thread-role.test.ts`, `server.test.ts` |
| Role Picker lists only Agent Roles (no `· Agent Roles` suffix). Its six local presets appear only when Agent Roles is unavailable or has no roles; `prepare` still resolves them, so a thread that already uses one keeps working (the picker shows it as "Unavailable role" until another is chosen). | `list` in `plugins/role-picker/server.ts`; test in `server.test.ts` |

Keep the plugin ids `agent-roles` and `role-picker`: their roles, teams, runs and thread role selections live in BB's data under those ids. Rebuild either with `bb plugin build plugins/<id>` and reload it.

## Taking an upstream update

```sh
bash "/Users/huntsyea/Dev/bb-plugins/sync-forks.sh"
```

The root [sync-forks.sh](/Users/huntsyea/Dev/bb-plugins/sync-forks.sh)
fetches and reports upstream changes; it does not merge or deploy.
Prepare the selected `agent-roles/vX.Y.Z` tag in an isolated `sync/<KEY>`
worktree. Preserve the fork changes above, record the rollback commit, and
validate `plugins/agent-roles` there. Report conflicts, results, and engine/SDK
compatibility to Warden. Follow the
[Warden reload protocol (ADR-0001)](/Users/huntsyea/Dev/bb-plugins/docs/adr/0001-warden-reload-approval.md)
before fast-forwarding the installed checkout or reloading. Warden must obtain
Hunter's approval and agree where agent-roles fits in the deployment order.
