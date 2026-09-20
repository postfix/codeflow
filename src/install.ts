import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { syncDirectory, writeAll } from "./artifacts.js";

export type WrapperHost = "codex" | "claude";

function outside(root: string, path: string): boolean {
  const item = relative(root, path);
  return item === ".." || item.startsWith(`..${sep}`);
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function projectDirectory(root: string, path: string): Promise<string> {
  // ponytail: Node has no openat-style no-follow mkdir; reject preexisting links, while same-user swaps remain outside v2.
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Wrapper parent must be a project directory");
  const actual = await realpath(path);
  if (outside(root, actual)) throw new Error("Wrapper parent escapes workspace");
  return actual;
}

async function writeNew(path: string, content: string): Promise<void> {
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await writeAll(file, Buffer.from(content)); await file.sync(); } finally { await file.close(); }
}

function skillInstructions(name: string, host: WrapperHost): string {
  return `---
name: ${name}
description: Run and reconnect to this Coding Flow through ${host}.
---

# ${name}

Use \`node launch.mjs <command> ...\`; the launcher fixes the provider to \`${host}\` for new runs.

1. Inspect the flow input requirements and obtain missing user input; serialize it once.
2. List unresolved runs before launch. Attach to a known active run; explicitly resume the intended interrupted run. Ask when several runs are plausible.
3. Launch once with the required edit authorization. Do not reproduce flow phases manually.
4. Poll with bounded waits. Reconnect with \`list\`, \`status\`, or \`resume\`; never duplicate a run.
5. Display each exact human request and its evidence, obtain the person's answer, preserve one submission ID, then use \`respond\`. Never infer consent.
6. Report blocks and permitted recovery actions. Never auto-retry an uncertain effect or weaken host restrictions.
7. Report the terminal engine result and any partial-effect warning; provider prose is not the engine outcome.
`;
}

function launcher(entry: string, host: WrapperHost): string {
  return `import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const project = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("coding-flow")));
const [command, ...rest] = process.argv.slice(2);
if (!command) throw new Error("Usage: node launch.mjs <command> [arguments]");
const args = command === "run"
  ? [cli, "run", resolve(project, ${JSON.stringify(entry)}), "--provider", ${JSON.stringify(host)}, ...rest]
  : [cli, command, ...rest];
const result = spawnSync(process.execPath, args, { cwd: project, stdio: "inherit", shell: false });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`;
}

export async function installWrapper(entry: string, host: WrapperHost, workspace = process.cwd()): Promise<string> {
  const root = await realpath(resolve(workspace));
  const source = await realpath(resolve(root, entry));
  if (outside(root, source)) throw new Error("Flow entry is outside workspace");
  const stem = basename(source, extname(source));
  const name = stem.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error("Flow entry cannot form a valid skill name");
  const hostRoot = await projectDirectory(root, join(root, host === "codex" ? ".agents" : ".claude"));
  const parent = await projectDirectory(root, join(hostRoot, "skills"));
  const target = join(parent, name);
  if (await exists(target)) throw new Error(`Wrapper target already exists: ${relative(root, target)}`);
  const temporary = join(parent, `.${name}.${randomUUID()}.tmp`);
  let claimed = false;
  try {
    await mkdir(temporary, { mode: 0o700 });
    await writeNew(join(temporary, "SKILL.md"), skillInstructions(name, host));
    await writeNew(join(temporary, "launch.mjs"), launcher(relative(root, source), host));
    await syncDirectory(temporary);
    await mkdir(target, { mode: 0o700 });
    claimed = true;
    await rename(join(temporary, "SKILL.md"), join(target, "SKILL.md"));
    await rename(join(temporary, "launch.mjs"), join(target, "launch.mjs"));
    await syncDirectory(target);
    await syncDirectory(parent);
    await rm(temporary, { recursive: true });
    return target;
  } catch (error) {
    if (claimed) await rm(target, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
