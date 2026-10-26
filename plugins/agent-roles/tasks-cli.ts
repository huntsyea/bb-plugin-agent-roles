// The `bb tasks … --json` runner: how this plugin reaches the builtin Tasks
// plugin, since plugins cannot call each other's RPC. Sync (Tasks presets) and
// role jobs (Tasks records) both take a BbTasksRunner; this is the production
// adapter, and tests pass an in-memory one.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

function findBbBinary(override: string): string {
  const candidates = [override.trim(), process.env.BB_CLI ?? "", "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb"].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return "bb";
}

/** Runs `bb tasks <args> --json` against this server and returns the parsed JSON. */
export type BbTasksRunner = (args: string[]) => Promise<Record<string, unknown>>;

export function makeBbTasksRunner(opts: { serverUrl: () => string; bbBinary: string }): BbTasksRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      let url = "";
      try { url = opts.serverUrl(); } catch { /* not listening yet */ }
      execFile(
        findBbBinary(opts.bbBinary),
        ["tasks", ...args, "--json"],
        { env: { ...process.env, ...(url ? { BB_SERVER_URL: url } : {}) }, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(`bb tasks ${args.slice(0, 2).join(" ")}: ${stderr.trim() || err.message}`));
          const text = String(stdout);
          const at = text.indexOf("{");
          try { resolve(JSON.parse(at >= 0 ? text.slice(at) : text)); } catch { resolve({}); }
        },
      );
    });
}
