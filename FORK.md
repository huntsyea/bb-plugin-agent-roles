# Fork notes

Local fork of [dmitriikapustin/bb-plugins-by-kapustin](https://github.com/dmitriikapustin/bb-plugins-by-kapustin), a monorepo of BB plugins.
`main` is our branch, pushed to `origin` ([huntsyea/bb-plugin-agent-roles](https://github.com/huntsyea/bb-plugin-agent-roles), a GitHub fork of upstream). The local folder and our fork are named for agent-roles, the only plugin we run from here.
The `upstream` remote is fetch-only (push is disabled).

- **Base:** upstream `main` at `agent-roles/v0.1.0`
- **Local checkout:** `/Users/huntsyea/Dev/bb-plugins/bb-plugin-agent-roles` (formerly named `kapustin`).
- **Installed in BB from this fork (2026-10-20):** `plugins/agent-roles` only. `bb plugin list` confirms its source is `/Users/huntsyea/Dev/bb-plugins/bb-plugin-agent-roles/plugins/agent-roles`.
- **Other installed plugins from upstream Git:** goals, role-picker, and visual-workflows. **my-tasks is not installed.**

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
| `bb role spawn --thread`, `bb role chat` and `bb role run` reuse the calling thread's environment only when it belongs to the target project. Before, a call from another project's thread failed with `409 Environment belongs to a different project`. | `contextFor` in `plugins/agent-roles/server.ts`, `inheritedEnvironmentId` in `plugins/agent-roles/shared.ts` |
| `bb role spawn --thread` and `bb role chat` take `--machine <id-or-name>` (that machine's project checkout) or `--environment <id>`, like `bb thread spawn`. `bb role run` takes `--environment`. Without either (and when the caller's environment doesn't carry over), the thread runs on the caller's machine if the target project has a local checkout there, else on the project's only local checkout. bb's project default, used when neither applies, resolves on the bb server's machine because the plugin calls bb from there; that's why `role spawn` 404'd where `thread spawn` (run from the caller's machine) worked. Team runs don't take `--machine` yet. | `resolveHostId`, `targetFor`, `contextFor` in `server.ts`; `roleThreadEnvironment`, `defaultHostId` in `shared.ts` |
| `bb role create <slug>` and `bb role update <role>` create and edit roles from the CLI, through the same validation as the Agent roles page. `--instructions-file` reads a file on the bb server's machine; `inherit` clears provider, model, reasoning or permission. Both report when instructions exceed what a role thread receives (about 3,700 characters after the role header), because bb otherwise truncates them silently. Teams are still edited only on the page, and there is no CLI delete. | `create`/`update` cases and `roleFieldsFrom`, `roomNote` in `server.ts`; `roleInstructionHead` (shared with `bb.agents.configure`) |

Keep the plugin id `agent-roles`. Its roles, teams and runs live in BB's per-plugin data under that id.

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
[Warden reload protocol](/Users/huntsyea/Dev/bb-plugins/docs/agents/warden-reload-protocol.md)
before fast-forwarding the installed checkout or reloading. Warden must obtain
Hunter's approval and agree where agent-roles fits in the deployment order.
