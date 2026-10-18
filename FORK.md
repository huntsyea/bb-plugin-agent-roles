# Fork notes

Local fork of [dmitriikapustin/bb-plugins-by-kapustin](https://github.com/dmitriikapustin/bb-plugins-by-kapustin), a monorepo of BB plugins.
`main` is our branch. The `upstream` remote is fetch-only (push is disabled).

- **Base:** upstream `main` at `agent-roles/v0.1.0`
- **Installed in BB from this fork:** `plugins/agent-roles` only (`bb plugin install <path>`). The other plugins here (goals, my-tasks, role-picker, visual-workflows) still install from upstream git.

## Our changes

| Change | Main files |
|---|---|
| `bb role spawn --thread`, `bb role chat` and `bb role run` reuse the calling thread's environment only when it belongs to the target project. Before, a call from another project's thread failed with `409 Environment belongs to a different project`. | `contextFor` in `plugins/agent-roles/server.ts`, `inheritedEnvironmentId` in `plugins/agent-roles/shared.ts` |
| `bb role spawn --thread` and `bb role chat` take `--machine <id-or-name>` (that machine's project checkout) or `--environment <id>`, like `bb thread spawn`. `bb role run` takes `--environment`. Without either, bb's project default applies, which resolves on the bb server. | `resolveHostId`, `targetFor` in `server.ts`, `roleThreadEnvironment` in `shared.ts` |
| `bb role create <slug>` and `bb role update <role>` create and edit roles from the CLI, through the same validation as the Agent roles page. `--instructions-file` reads a file on the bb server's machine; `inherit` clears provider, model, reasoning or permission. Both report when instructions exceed what a role thread receives (about 3,700 characters after the role header), because bb otherwise truncates them silently. Teams are still edited only on the page, and there is no CLI delete. | `create`/`update` cases and `roleFieldsFrom`, `roomNote` in `server.ts`; `roleInstructionHead` (shared with `bb.agents.configure`) |

Keep the plugin id `agent-roles`. Its roles, teams and runs live in BB's per-plugin data under that id.

## Taking an upstream update

```sh
../sync-forks.sh                 # what upstream has that we don't
git merge agent-roles/vX.Y.Z     # upstream releases are tags prefixed by plugin
# resolve conflicts, keeping both upstream's change and ours above
cd plugins/agent-roles && npx tsc --noEmit && npm test
npm run build && bb plugin reload agent-roles
```
