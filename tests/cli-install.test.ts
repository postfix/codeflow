import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { executeCommand } from "../src/cli.js";

const sdk = new URL("../src/sdk.ts", import.meta.url).pathname;
const temporary: string[] = [];

async function workspace(name: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `codeflow-cli-${name}-`)));
  temporary.push(root);
  return root;
}

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function invoke(root: string, args: readonly string[]): Promise<{ readonly status: number; readonly stdout: unknown }> {
  const [command, ...rest] = args;
  if (!command) throw new Error("command required");
  const result = await executeCommand(command, ["--workspace", root, ...rest]);
  expect(() => JSON.parse(JSON.stringify(result.value))).not.toThrow();
  return { status: result.exitCode, stdout: result.value };
}

async function flow(root: string, body: string): Promise<string> {
  const path = join(root, "flow;not-a-shell.ts");
  await writeFile(path, `
    import { flow, z } from ${JSON.stringify(sdk)};
    export default flow({ name: "cli-test", description: "CLI lifecycle test",
      input: z.null(), output: z.json(), async run(context) { ${body} } });
  `);
  return path;
}

describe("lifecycle CLI and wrapper installation", () => {
  test("rejects unknown flags and malformed JSON with one sanitized JSON result", async () => {
    const root = await workspace("strict");
    await expect(invoke(root, ["list", "--latest"])).rejects.toThrow("Unknown flag --latest");
    const entry = await flow(root, "return { ok: true };");
    const input = join(root, "private-input.json");
    await writeFile(input, "private-not-json");
    await expect(invoke(root, ["run", entry, "--provider", "codex", "--input", input, "--model", "test"]))
      .rejects.toThrow("Invalid JSON in");
  });

  test("runs, lists, inspects, and explicitly prunes one terminal run", async () => {
    const root = await workspace("lifecycle");
    const entry = await flow(root, "return { ok: true };");
    const input = join(root, "input.json");
    await writeFile(input, "null");
    const started = await invoke(root, [
      "run", entry, "--provider", "codex", "--input", input, "--model", "test", "--wait-ms", "30000",
    ]);
    expect(started.status).toBe(0);
    expect(started.stdout).toMatchObject({ status: "succeeded", output: { ok: true } });
    const runId = (started.stdout as { runId: string }).runId;
    expect((await invoke(root, ["status", runId])).stdout).toEqual(started.stdout);
    expect((await invoke(root, ["recovery", runId])).stdout).toEqual(started.stdout);
    expect((await invoke(root, ["list"])).stdout).toEqual([started.stdout]);
    expect((await invoke(root, ["inspect", entry])).stdout).toMatchObject({
      name: "cli-test", description: "CLI lifecycle test", input: { type: "null" }, output: {},
    });
    const pruned = await invoke(root, ["prune", runId]);
    expect(pruned).toMatchObject({ status: 0, stdout: { pruned: [runId] } });
    expect((await invoke(root, ["list"])).stdout).toEqual([]);
  });

  test("uses the host reply path for a human boundary and preserves exit codes", async () => {
    const root = await workspace("respond");
    const entry = await flow(root, `
      return await context.human.ask({ question: "Choose", presentation: { title: "Evidence", markdown: "Exact" }, output: z.enum(["a", "b"]) });
    `);
    const input = join(root, "input.json");
    await writeFile(input, "null");
    const waiting = await invoke(root, [
      "run", entry, "--provider", "codex", "--input", input, "--model", "test", "--wait-ms", "30000",
    ]);
    expect(waiting.status).toBe(10);
    const boundary = waiting.stdout as {
      runId: string;
      request: { requestId: string; revision: string; presentationHash: string };
    };
    const replyDirectory = await workspace("reply-file");
    const reply = join(replyDirectory, "reply.json");
    await writeFile(reply, JSON.stringify({
      submissionId: "cli-reply-1", requestId: boundary.request.requestId, revision: boundary.request.revision,
      presentationHash: boundary.request.presentationHash, answer: "a",
    }));
    expect(await invoke(root, ["respond", boundary.runId, "--input", reply])).toMatchObject({
      status: 0, stdout: { submissionId: "cli-reply-1", status: "accepted" },
    });
    expect((await invoke(root, ["status", boundary.runId, "--wait-ms", "30000"])).stdout).toMatchObject({ status: "succeeded", output: "a" });
  });

  test("installs thin provider-fixed wrappers without overwrite or ignore-file edits", async () => {
    const root = await workspace("install");
    const entry = await flow(root, "return { ok: true };");
    await writeFile(join(root, ".gitignore"), "owned-by-user\n");
    const installed = await invoke(root, ["install", entry, "--host", "codex"]);
    expect(installed.status).toBe(0);
    const target = (installed.stdout as { target: string }).target;
    const launch = await readFile(join(target, "launch.mjs"), "utf8");
    const skill = await readFile(join(target, "SKILL.md"), "utf8");
    expect(launch).toContain('[cli, "run", resolve(project,');
    expect(launch).toContain('"--provider", "codex"');
    expect(launch).toContain("shell: false");
    expect(skill).toContain("Never infer consent");
    await expect(invoke(root, ["install", entry, "--host", "codex"])).rejects.toThrow("already exists");
    await expect(readFile(join(root, ".gitignore"), "utf8")).resolves.toBe("owned-by-user\n");
  });

  test.each([
    ["codex", ".agents"],
    ["claude", ".claude"],
  ] as const)("rejects a preexisting %s host-directory symlink without external writes", async (host, hostDirectory) => {
    const root = await workspace(`install-${host}-symlink`);
    const outside = await workspace(`install-${host}-outside`);
    const entry = await flow(root, "return { ok: true };");
    await symlink(outside, join(root, hostDirectory), "dir");

    const result = await invoke(root, ["install", entry, "--host", host])
      .then(() => "installed", () => "rejected");
    expect({ result, outside: await readdir(outside) }).toEqual({ result: "rejected", outside: [] });
  });
});
