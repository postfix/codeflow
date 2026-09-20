import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { publishJson } from "../src/artifacts.js";
import { providerConfigurationHash, type Adapter, type ProviderObservation, type ProviderRequest } from "../src/adapters/types.js";
import { decodeCodexResult } from "../src/adapters/codex.js";
import { canonicalJson, type Json } from "../src/contracts.js";
import { openRun, resumeRun, startFlow } from "../src/host.js";
import { Journal, readVerifiedEvents } from "../src/journal.js";
import { ProcessService } from "../src/process.js";
import { captureInitialWorkspace, CommittedRejection, ReplayFrontier } from "../src/replay.js";
import { flow, z, type Flow, type FlowContext } from "../src/sdk.js";
import { dispatchProvider } from "../src/supervisor.js";
import { withTestControl } from "../src/testing.js";
import { FlowRuntimeError, runFlow } from "../src/worker.js";
import { captureWorkspace } from "../src/workspace.js";

const exec = promisify(execFile);
const temporary: string[] = [];
const runtime = { provider: "codex" as const };

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "coding-flow-"));
  temporary.push(path);
  return path;
}

async function storedBytes(path: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(path)) {
    const child = join(path, name);
    const info = await stat(child);
    total += info.isDirectory() ? await storedBytes(child) : info.size;
  }
  return total;
}

async function hostFlow(root: string): Promise<URL> {
  const target = join(root, "host-flow.ts");
  const source = await readFile(new URL("./fixtures/host-flow.ts", import.meta.url), "utf8");
  const sdk = fileURLToPath(new URL("../dist/src/sdk.js", import.meta.url));
  await writeFile(target, source.replace("../../src/sdk.js", sdk));
  return pathToFileURL(target);
}

async function launchAndExit(entry: URL, root: string): Promise<string> {
  const host = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "../dist/src/host.js"));
  const source = `
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { startFlow } from ${JSON.stringify(host.href)};
    const handle = await startFlow(new URL(process.env.FLOW_ENTRY), JSON.parse(process.env.FLOW_INPUT), {
      workspace: process.env.FLOW_WORKSPACE,
      runtime: { provider: "codex" },
    });
    writeFileSync(join(process.env.FLOW_WORKSPACE, ".launcher-run-id"), handle.runId);
  `;
  await exec(process.execPath, ["--input-type=module", "--eval", source], {
    env: {
      ...process.env,
      FLOW_ENTRY: entry.href,
      FLOW_INPUT: JSON.stringify({ message: "durable", delayMs: 1_500 }),
      FLOW_WORKSPACE: root,
    },
  });
  return readFile(join(root, ".launcher-run-id"), "utf8");
}

async function stableLockIsHeld(root: string): Promise<boolean> {
  const source = `
    import { openSync, closeSync } from "node:fs";
    import { flockSync } from "fs-ext";
    const fd = openSync(process.argv[1], "a+");
    try { flockSync(fd, "exnb"); process.exitCode = 2; }
    catch (error) { process.exitCode = ["EAGAIN", "EWOULDBLOCK"].includes(error.code) ? 0 : 3; }
    finally { closeSync(fd); }
  `;
  try {
    await exec(process.execPath, ["--input-type=module", "--eval", source, join(root, ".coding-flow/lock")]);
    return true;
  } catch {
    return false;
  }
}

async function waitForLockRelease(root: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (await stableLockIsHeld(root)) {
    if (Date.now() >= deadline) throw new Error("Crashed supervisor did not release its lock");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}

const placeholderArtifact = {
  path: "artifacts/placeholder.json",
  sha256: "0".repeat(64),
  bytes: 0,
  mediaType: "application/json",
};

function createdData(root: string, runId: string): Json {
  return {
    runId,
    entry: "file:///fixture.ts",
    workspace: root,
    inputArtifact: placeholderArtifact,
    bundleArtifact: placeholderArtifact,
    initializationCharges: { compilations: 1, inputValidations: 0 },
    supervisorPid: 1,
  };
}

const initializedData = {
  inputArtifact: placeholderArtifact,
  bundleArtifact: placeholderArtifact,
  initializationCharges: { compilations: 1, inputValidations: 1 },
  supervisorPid: 2,
} satisfies Json;

const succeededData = { outputArtifact: placeholderArtifact } satisfies Json;
const failedData = { errorArtifact: placeholderArtifact } satisfies Json;

const replayLimits = { maxCommands: 1, maxAgentCalls: 3 };

function discardForTest(_promise: Promise<unknown>): void {}

async function replayFixture(limits = replayLimits, selectedRuntime?: Json): Promise<{
  readonly root: string;
  readonly runId: string;
  readonly runDirectory: string;
  readonly journal: Journal;
}> {
  const root = await workspace();
  await writeFile(join(root, "tracked.txt"), "base\n");
  const runId = randomUUID();
  const runDirectory = join(root, ".coding-flow/runs", runId);
  await mkdir(join(runDirectory, "artifacts"), { recursive: true });
  const journal = new Journal(runDirectory, runId);
  await journal.append("run.created", { ...(createdData(root, runId) as Record<string, Json>), ...(selectedRuntime ? { runtime: selectedRuntime } : {}) });
  await journal.append("run.initialized", initializedData);
  await captureInitialWorkspace(runDirectory, journal, root, limits);
  return { root, runId, runDirectory, journal };
}

async function replayFrontier(fixture: Awaited<ReturnType<typeof replayFixture>>, limits = replayLimits): Promise<ReplayFrontier> {
  const history = await readVerifiedEvents(fixture.root, fixture.runId);
  return ReplayFrontier.open({
    runDirectory: fixture.runDirectory,
    runId: fixture.runId,
    journal: new Journal(fixture.runDirectory, fixture.runId, history),
    history,
    limits,
  });
}

function requestHash(request: Json): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

describe("execution and replay", () => {
  test("a failed journal append poisons that writer", async () => {
    const root = await workspace();
    const runId = "00000000-0000-4000-8000-000000000008";
    const runDirectory = join(root, ".coding-flow/runs", runId);
    const eventsPath = join(runDirectory, "events.jsonl");
    await mkdir(runDirectory, { recursive: true });
    await symlink("/dev/full", eventsPath);
    const journal = new Journal(runDirectory, runId);

    await expect(journal.append("run.created", {})).rejects.toThrow();
    await unlink(eventsPath);
    await expect(journal.append("run.created", {})).rejects.toThrow("Journal append outcome is uncertain");
  });

  test("rejects hash-valid illegal journal transitions", async () => {
    const cases = [
      ["run.succeeded"],
      ["run.created", "run.created"],
      ["run.created", "run.initialized", "run.initialized"],
      ["run.created", "run.succeeded"],
      ["run.created", "run.failed", "run.initialized"],
      ["run.created", "run.initialized", "run.succeeded", "run.failed"],
    ] as const;

    for (const [index, types] of cases.entries()) {
      const root = await workspace();
      const runId = `00000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`;
      const runDirectory = join(root, ".coding-flow/runs", runId);
      await mkdir(runDirectory, { recursive: true });
      const journal = new Journal(runDirectory, runId);
      for (const type of types) {
        const data = type === "run.created" ? createdData(root, runId)
          : type === "run.initialized" ? initializedData
            : type === "run.succeeded" ? succeededData
              : failedData;
        await journal.append(type, data);
      }

      await expect(readVerifiedEvents(root, runId)).rejects.toThrow("Corrupt journal");
    }
  });

  test("accepts initialization failures as a legal terminal transition", async () => {
    const root = await workspace();
    const runId = "00000000-0000-4000-8000-000000000030";
    const runDirectory = join(root, ".coding-flow/runs", runId);
    await mkdir(runDirectory, { recursive: true });
    const journal = new Journal(runDirectory, runId);
    await journal.append("run.created", createdData(root, runId));
    await journal.append("run.failed", failedData);

    await expect(readVerifiedEvents(root, runId)).resolves.toHaveLength(2);
  });

  test("result projection failure does not append a second terminal event", async () => {
    const root = await workspace();
    const entry = await hostFlow(root);
    const started = await startFlow(entry, { message: "durable", delayMs: 300 }, { workspace: root, runtime });
    const runDirectory = join(root, ".coding-flow/runs", started.runId);
    await mkdir(join(runDirectory, "result.json"));

    await waitForLockRelease(root);
    await expect(openRun(root, started.runId).wait(100)).resolves.toMatchObject({ status: "succeeded" });
    const events = await readVerifiedEvents(root, started.runId);
    expect(events.filter((event) => event.type === "run.succeeded" || event.type === "run.failed")).toHaveLength(1);
  });

  test("large final output stays in an artifact and projects through the host boundary", async () => {
    const root = await workspace();
    const entry = join(root, "large-output.mjs");
    await writeFile(entry, `export default {
      kind: "coding-flow/v2",
      input: { parse: value => value },
      output: { parse: value => value },
      run: async () => "x".repeat(300 * 1024)
    };\n`);

    const started = await startFlow(pathToFileURL(entry), {}, { workspace: root, runtime });
    await waitForLockRelease(root);
    const terminal = await started.wait(10_000);
    expect(terminal.status).toBe("succeeded");
    if (terminal.status === "succeeded") expect(terminal.output).toHaveLength(300 * 1024);
    const record = (await readVerifiedEvents(root, started.runId)).at(-1);
    expect(Buffer.byteLength(`${JSON.stringify(record)}\n`)).toBeLessThanOrEqual(256 * 1024);
    expect(record?.data).not.toHaveProperty("output");
  }, 20_000);

  test("large failure detail stays in an artifact and projects through the host boundary", async () => {
    const root = await workspace();
    const entry = join(root, "large-error.mjs");
    await writeFile(entry, `export default {
      kind: "coding-flow/v2",
      input: { parse: value => value },
      output: { parse: value => value },
      run: async () => { throw new Error("x".repeat(300 * 1024)); }
    };\n`);

    const started = await startFlow(pathToFileURL(entry), {}, { workspace: root, runtime });
    await waitForLockRelease(root);
    const terminal = await started.wait(2_000);
    expect(terminal.status).toBe("failed");
    if (terminal.status === "failed") expect(terminal.error.message).toHaveLength(300 * 1024);
    const record = (await readVerifiedEvents(root, started.runId)).at(-1);
    expect(Buffer.byteLength(`${JSON.stringify(record)}\n`)).toBeLessThanOrEqual(256 * 1024);
    expect(record?.data).not.toHaveProperty("message");
  }, 10_000);

  test.each(["../outside", "nested/run", "nested\\run"])("rejects path-like run ID %s", async (runId) => {
    const root = await workspace();

    expect(() => openRun(root, runId)).toThrow("Invalid run ID");
  });

  test("minimal durable pure flow", async () => {
    const root = await workspace();
    const entry = await hostFlow(root);

    const runId = await launchAndExit(entry, root);
    const eventsPath = join(root, ".coding-flow/runs", runId, "events.jsonl");
    const createdAtReturn = (await readFile(eventsPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(createdAtReturn.some((event) => event.type === "run.created")).toBe(true);
    expect(await stableLockIsHeld(root)).toBe(true);

    const terminal = await openRun(root, runId).wait(10_000);
    expect(terminal).toMatchObject({ status: "succeeded", output: { echoed: "durable" } });
    const finalEvents = (await readFile(eventsPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(finalEvents.filter((event) => event.type === "run.succeeded")).toHaveLength(1);

    const invalidRoot = await workspace();
    const invalid = await startFlow(await hostFlow(invalidRoot), { message: 42, delayMs: 0 }, {
      workspace: invalidRoot,
      runtime,
    });
    await expect(invalid.wait(10_000)).resolves.toMatchObject({ status: "failed" });
    await expect(open(join(invalidRoot, "body-effects.txt"), "r")).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  test("initialization and contract resume preserves pinned identity and charges", async () => {
    const root = await workspace();
    const entry = await hostFlow(root);
    const started = await startFlow(entry, { message: "resumed", delayMs: 0 }, withTestControl(
      { workspace: root, runtime },
      { crashAfterRunCreated: true },
    ));
    const eventsPath = join(root, ".coding-flow/runs", started.runId, "events.jsonl");

    await waitForLockRelease(root);
    const beforeResume = (await readFile(eventsPath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(beforeResume.map((event) => event.type)).toEqual(["run.created"]);

    const resumed = await resumeRun(root, started.runId);
    await expect(resumed.wait(10_000)).resolves.toMatchObject({
      status: "succeeded",
      output: { echoed: "resumed" },
    });

    const events = (await readFile(eventsPath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    const created = events.find((event) => event.type === "run.created");
    const initialized = events.find((event) => event.type === "run.initialized");
    expect(initialized.data).toMatchObject({
      bundleArtifact: created.data.bundleArtifact,
      inputArtifact: created.data.inputArtifact,
      initializationCharges: { compilations: 1, inputValidations: 1 },
    });
    expect(initialized.data.supervisorPid).not.toBe(created.data.supervisorPid);
    expect(events.filter((event) => event.type === "run.initialized")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.succeeded")).toHaveLength(1);
  }, 20_000);

  test("initialization and contract rejects a manifest artifact swap before execution", async () => {
    const root = await workspace();
    const entry = await hostFlow(root);
    const started = await startFlow(entry, { message: "original", delayMs: 0 }, withTestControl(
      { workspace: root, runtime },
      { crashAfterRunCreated: true },
    ));
    const runDirectory = join(root, ".coding-flow/runs", started.runId);

    await waitForLockRelease(root);
    const swappedInput = Buffer.from(`${JSON.stringify({ message: "swapped", delayMs: 0 })}\n`);
    await writeFile(join(runDirectory, "artifacts/swapped-input.json"), swappedInput);
    const manifestPath = join(runDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.inputArtifact = {
      path: "artifacts/swapped-input.json",
      sha256: createHash("sha256").update(swappedInput).digest("hex"),
      bytes: swappedInput.length,
      mediaType: "application/json",
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    await expect(resumeRun(root, started.runId)).rejects.toThrow("Corrupt journal");
    await expect(open(join(root, "body-effects.txt"), "r")).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  test("rejects journals with more than one terminal event", async () => {
    for (const [runId, terminalTypes] of [
      ["00000000-0000-4000-8000-000000000001", ["run.succeeded", "run.succeeded"]],
      ["00000000-0000-4000-8000-000000000002", ["run.succeeded", "run.failed"]],
    ] as const) {
      const root = await workspace();
      const runDirectory = join(root, ".coding-flow/runs", runId);
      await mkdir(runDirectory, { recursive: true });
      const journal = new Journal(runDirectory, runId);
      await journal.append("run.created", createdData(root, runId));
      await journal.append("run.initialized", initializedData);
      for (const type of terminalTypes) await journal.append(type, {});

      await expect(openRun(root, runId).wait(100)).rejects.toThrow("Corrupt journal");
    }
  });

  test("rejects malformed terminal payloads as corrupt", async () => {
    for (const [runId, terminalType] of [
      ["00000000-0000-4000-8000-000000000003", "run.succeeded"],
      ["00000000-0000-4000-8000-000000000004", "run.failed"],
    ] as const) {
      const root = await workspace();
      const runDirectory = join(root, ".coding-flow/runs", runId);
      await mkdir(runDirectory, { recursive: true });
      const journal = new Journal(runDirectory, runId);
      await journal.append("run.created", createdData(root, runId));
      if (terminalType === "run.succeeded") await journal.append("run.initialized", initializedData);
      await journal.append(terminalType, {});

      await expect(openRun(root, runId).wait(100)).rejects.toThrow("Corrupt journal");
    }
  });

  test.each(
    [
      { runId: "00000000-0000-4000-8000-000000000005", kind: "missing" },
      { runId: "00000000-0000-4000-8000-000000000006", kind: "modified" },
      { runId: "00000000-0000-4000-8000-000000000007", kind: "escaping" },
    ] as const,
  )("rejects $kind output artifact", async ({ runId, kind }) => {
    const root = await workspace();
    const runDirectory = join(root, ".coding-flow/runs", runId);
    await mkdir(runDirectory, { recursive: true });
    const original = Buffer.from("original\n");
    const outputPath = kind === "escaping" ? "../../outside.json" : "output.json";
    if (kind !== "missing") {
      await writeFile(join(runDirectory, outputPath), kind === "modified" ? "modified\n" : original);
    }
    const journal = new Journal(runDirectory, runId);
    await journal.append("run.created", createdData(root, runId));
    await journal.append("run.initialized", initializedData);
    await journal.append("run.succeeded", {
      outputArtifact: {
        path: outputPath,
        sha256: createHash("sha256").update(original).digest("hex"),
        bytes: original.length,
        mediaType: "application/json",
      },
    });

    await expect(openRun(root, runId).wait(100)).rejects.toThrow(kind === "escaping" ? "Corrupt journal" : "EVIDENCE_CORRUPT");
  });

  test("waits for the supervisor handshake without an arbitrary timeout", async () => {
    const root = await workspace();
    const entry = await hostFlow(root);
    const starting = startFlow(entry, { message: "durable", delayMs: 0 }, { workspace: root, runtime });

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_100);

    await expect(starting).resolves.toHaveProperty("runId");
  }, 10_000);
});

describe("replay frontier limits freshness", () => {
  test("rejects malformed or over-limit reconstructed reservations before dispatch", async () => {
    for (const [label, limits, reservation] of [
      ["wrong-kind", replayLimits, { commands: 1, agentCalls: 0 }],
      ["over-limit", { maxCommands: 1, maxAgentCalls: 0 }, { commands: 0, agentCalls: 1 }],
    ] as const) {
      const fixture = await replayFixture(limits);
      const request = { trace: ["root", 1], schema: "review/v1", prompt: label } satisfies Json;
      await fixture.journal.append("operation.prepared", {
        ordinal: 1, scope: "root", kind: "agent", request, requestHash: requestHash(request),
        preWorkspaceHash: (JSON.parse(await readFile(join(fixture.runDirectory, "artifacts/workspace-initial.json"), "utf8")) as { sha256: string }).sha256,
        reservation,
      });
      let dispatches = 0;
      await expect(replayFrontier(fixture, limits)).rejects.toThrow("HISTORY_MISMATCH");
      expect(dispatches).toBe(0);
    }
  });

  test("checks admission-open before the final freshness check", async () => {
    const fixture = await replayFixture();
    const frontier = await replayFrontier(fixture);
    let dispatches = 0;
    let preparations = 0;
    await expect(frontier.perform("agent", {
      trace: ["root", 1], schema: "review/v1", prompt: "fresh",
    }, async () => {
      dispatches += 1;
      return { verdict: "must-not-run" };
    }, () => {
      writeFileSync(join(fixture.root, "tracked.txt"), "changed-before-final-check\n");
      return true;
    }, async () => {
      preparations += 1;
    })).rejects.toThrow("Workspace is stale");
    expect(dispatches).toBe(0);
    expect(preparations).toBe(0);
    expect((await readVerifiedEvents(fixture.root, fixture.runId)).filter(({ type }) => type === "operation.prepared")).toHaveLength(0);
  });

  test("skips preparation when admission is closed", async () => {
    const fixture = await replayFixture();
    let preparations = 0;
    await expect((await replayFrontier(fixture)).perform("agent", {
      trace: ["root", 1], schema: "review/v1", prompt: "closed",
    }, async () => ({ verdict: "must-not-run" }), () => false, async () => {
      preparations += 1;
    })).rejects.toThrow("COMMAND_CLOSED");
    expect(preparations).toBe(0);
  });

  test("actual host resume anchors an orphan identical initial workspace artifact", async () => {
    const root = await workspace();
    const entry = await hostFlow(root);
    const started = await startFlow(entry, { message: "resumed-after-initialization", delayMs: 0 }, withTestControl(
      { workspace: root, runtime },
      { crashAfterRunCreated: true },
    ));
    await waitForLockRelease(root);
    const runDirectory = join(root, ".coding-flow/runs", started.runId);
    const history = await readVerifiedEvents(root, started.runId);
    const created = history[0]!.data as { readonly inputArtifact: Json; readonly bundleArtifact: Json };
    const journal = new Journal(runDirectory, started.runId, history);
    await journal.append("run.initialized", {
      inputArtifact: created.inputArtifact,
      bundleArtifact: created.bundleArtifact,
      initializationCharges: { compilations: 1, inputValidations: 1 },
      supervisorPid: process.pid,
    });
    await publishJson(runDirectory, join(runDirectory, "artifacts/workspace-initial.json"), await captureWorkspace(root) as unknown as Json);

    const resumed = await resumeRun(root, started.runId);
    await expect(resumed.wait(5_000)).resolves.toMatchObject({
      status: "succeeded",
      output: { echoed: "resumed-after-initialization" },
    });
    const resumedHistory = await readVerifiedEvents(root, started.runId);
    expect(resumedHistory.filter(({ type }) => type === "workspace.captured")).toHaveLength(1);
  }, 10_000);

  test("actual host resume preserves the nonterminal frontier when orphan initial evidence differs", async () => {
    const root = await workspace();
    const entry = await hostFlow(root);
    const started = await startFlow(entry, { message: "must-not-dispatch", delayMs: 0 }, withTestControl(
      { workspace: root, runtime },
      { crashAfterRunCreated: true },
    ));
    await waitForLockRelease(root);
    const runDirectory = join(root, ".coding-flow/runs", started.runId);
    const history = await readVerifiedEvents(root, started.runId);
    const created = history[0]!.data as { readonly inputArtifact: Json; readonly bundleArtifact: Json };
    const journal = new Journal(runDirectory, started.runId, history);
    await journal.append("run.initialized", {
      inputArtifact: created.inputArtifact,
      bundleArtifact: created.bundleArtifact,
      initializationCharges: { compilations: 1, inputValidations: 1 },
      supervisorPid: process.pid,
    });
    await publishJson(runDirectory, join(runDirectory, "artifacts/workspace-initial.json"), await captureWorkspace(root) as unknown as Json);
    await writeFile(join(root, "external-change.txt"), "different workspace\n");
    const eventsPath = join(runDirectory, "events.jsonl");
    const frontier = await readFile(eventsPath, "utf8");

    await resumeRun(root, started.runId);
    await waitForLockRelease(root);

    expect((await readFile(eventsPath, "utf8")).startsWith(frontier)).toBe(true);
    const resumedHistory = await readVerifiedEvents(root, started.runId);
    expect(resumedHistory.map(({ type }) => type)).toEqual(["run.created", "run.initialized", "attempt.started"]);
    expect(resumedHistory.at(-1)?.data).toEqual({ attempt: 2, cause: "resume" });
    await expect(readFile(join(root, "body-effects.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);

  test("replays resolved and rejected committed fake-provider outcomes without redispatch", async () => {
    const fixture = await replayFixture();
    const firstRequest = { trace: ["root", 1], schema: "review/v1", prompt: "inspect" } satisfies Json;
    const secondRequest = { trace: ["root", 2], schema: "review/v1", prompt: "reject" } satisfies Json;
    let dispatches = 0;
    const frontier = await replayFrontier(fixture);

    await expect(frontier.perform("agent", firstRequest, async () => {
      dispatches += 1;
      return { verdict: "pass" };
    })).resolves.toEqual({ verdict: "pass" });
    await expect(frontier.perform("agent", secondRequest, async () => {
      dispatches += 1;
      throw new CommittedRejection("INVALID_AGENT_OUTPUT", "schema rejected");
    })).rejects.toMatchObject({ code: "INVALID_AGENT_OUTPUT", message: "schema rejected" });

    const replayed = await replayFrontier(fixture);
    await expect(replayed.perform("agent", firstRequest, async () => {
      dispatches += 1;
      return { verdict: "wrong" };
    })).resolves.toEqual({ verdict: "pass" });
    await expect(replayed.perform("agent", secondRequest, async () => {
      dispatches += 1;
      return { verdict: "wrong" };
    })).rejects.toMatchObject({ code: "INVALID_AGENT_OUTPUT", message: "schema rejected" });
    expect(dispatches).toBe(2);
  });

  test("native evidence provider observations bind durable attempts and committed replay emits no probes or observations", async () => {
    const fixture = await replayFixture(replayLimits, { provider: "codex", executable: process.execPath, model: "test-model" });
    const request = { trace: ["root", 1], prompt: "binding", access: "read", schema: "text/v1" } satisfies Json;
    let probes = 0;
    let captures = 0;
    const adapter: Adapter = {
      async status() { probes += 1; return { provider: "codex", executable: process.execPath, version: "0.154.0", auth: "subscription", qualified: true }; },
      invocation() { return { executable: process.execPath, args: ["-e", "process.stdout.write('ok')"], cwd: fixture.root, stdin: "" }; },
      async capture(providerRequest, returned, context) {
        captures += 1;
        const id = "00000000-0000-4000-8000-000000000011";
        const digest = (text: string) => createHash("sha256").update(text).digest("hex");
        return { version: 1, captureContext: context, status: { exitCode: returned.exitCode, signal: returned.signal, errorPresent: !!returned.error },
          stdout: Buffer.from(`${JSON.stringify({ type: "thread.started", thread_id: id })}\n${JSON.stringify({ type: "turn.completed" })}\n`),
          finalOutput: Buffer.from("unchanged"), codexSession: { sessionIdSha256: digest(id), source: "exec", cliVersion: "0.154.0",
            workspaceSha256: digest(providerRequest.workspace), promptSha256: digest(providerRequest.prompt), startedAt: context.startedAt,
            models: ["test-model"] } };
      },
      decode: decodeCodexResult,
    };
    const service = new ProcessService();
    const run = async (stopAfterObservation = false) => {
      const history = await readVerifiedEvents(fixture.root, fixture.runId);
      const journal = new Journal(fixture.runDirectory, fixture.runId, history);
      const frontier = await ReplayFrontier.open({ ...fixture, history, journal, limits: replayLimits });
      return dispatchProvider({ adapter, service, runDirectory: fixture.runDirectory, attemptId: "agent-1", signal: new AbortController().signal,
        request: { prompt: "binding", access: "read", model: "test-model", workspace: fixture.root, operationDirectory: fixture.runDirectory, timeoutMs: 5_000 },
        observation: { workspace: fixture.root, runId: fixture.runId, journal, request, executable: process.execPath },
        perform: (dispatch, prepare, afterPrepared) => frontier.perform("agent", request, dispatch, () => true, prepare, async (binding) => {
          await afterPrepared(binding);
          if (stopAfterObservation) throw new Error("STOP_AFTER_OBSERVATION");
        }),
        async prepare() {},
      });
    };
    try {
      await expect(run(true)).rejects.toThrow("STOP_AFTER_OBSERVATION");
      const prepared = await readVerifiedEvents(fixture.root, fixture.runId);
      expect(prepared.filter(({ type }) => type === "provider.observed")).toHaveLength(1);
      expect(prepared.filter(({ type }) => type === "dispatch.authorized")).toHaveLength(0);
      expect(await run()).toBe("unchanged");
      const first = await readVerifiedEvents(fixture.root, fixture.runId);
      expect(first.filter(({ type }) => type === "provider.observed")).toHaveLength(2);
      expect(await run()).toBe("unchanged");
      expect(await readVerifiedEvents(fixture.root, fixture.runId)).toEqual(first);
      expect(probes).toBe(1);
      expect(captures).toBe(1);
    } finally { await service.dispose(); }
  }, 15_000);

  test.each(["duplicate", "runId", "preparedHash", "attempt", "ownershipGeneration", "configurationSha256", "boundaryId"])("rejects %s provider evidence before target dispatch", async (tamper) => {
    const fixture = await replayFixture(replayLimits, { provider: "codex", model: "fixture-model" });
    const request = { trace: ["root", 1], prompt: "binding" } satisfies Json;
    const history = await readVerifiedEvents(fixture.root, fixture.runId);
    const frontier = await ReplayFrontier.open({ ...fixture, history, limits: replayLimits });
    let observation: ProviderObservation | undefined;
    let dispatches = 0;
    await expect(frontier.perform("agent", request, async () => { dispatches += 1; return "effect"; }, () => true, async () => undefined, async (binding) => {
      observation = { provider: "codex", phase: "preflight", runId: fixture.runId, boundaryId: "agent-1", ordinal: binding.ordinal,
        preparedHash: binding.preparedHash, attempt: 1, ownershipGeneration: 1, executableSha256: "0".repeat(64),
        configurationSha256: providerConfigurationHash("codex", "fixture-model", request, "0".repeat(64)), executableVersion: "0.154.0",
        auth: "subscription", requestedModel: "fixture-model", outcome: "ready" };
      const observationArtifact = await publishJson(fixture.runDirectory, join(fixture.runDirectory, "artifacts/observation.json"), observation as unknown as Json);
      await fixture.journal.append("provider.observed", { observationArtifact } as unknown as Json);
      throw new Error("STOP_BEFORE_AUTHORIZATION");
    })).rejects.toThrow("STOP_BEFORE_AUTHORIZATION");
    expect(dispatches).toBe(0);
    const valid = await readVerifiedEvents(fixture.root, fixture.runId);
    if (tamper === "duplicate") await fixture.journal.append("provider.observed", valid.at(-1)!.data);
    else {
      const changes: Record<string, Json> = { runId: randomUUID(), preparedHash: "1".repeat(64), attempt: 2, ownershipGeneration: 2, configurationSha256: "1".repeat(64), boundaryId: "agent-2" };
      const observationArtifact = await publishJson(fixture.runDirectory, join(fixture.runDirectory, "artifacts/forged.json"), { ...observation, [tamper]: changes[tamper] } as Json);
      await fixture.journal.append("provider.observed", { observationArtifact } as unknown as Json);
    }
    await expect(readVerifiedEvents(fixture.root, fixture.runId)).rejects.toThrow("PROVIDER_EVIDENCE_MISMATCH");
  });

  test("post-prepare hook binds durable operation before authorization and skips committed replay", async () => {
    const fixture = await replayFixture();
    const request = { trace: ["root", 1], prompt: "binding" } satisfies Json;
    const order: string[] = [];
    let dispatches = 0;
    const perform = async (frontier: ReplayFrontier) => Reflect.apply(frontier.perform, frontier, [
      "agent", request, async () => { dispatches += 1; order.push("dispatch"); return "value"; },
      () => true, async () => { order.push("prepare"); },
      async (binding: { preparedHash: string; ordinal: number; kind: string }) => {
        const history = await readVerifiedEvents(fixture.root, fixture.runId);
        expect(history.at(-1)).toMatchObject({ type: "operation.prepared", hash: binding.preparedHash });
        expect(binding).toMatchObject({ ordinal: 1, kind: "agent" });
        expect(history.some(({ type }) => type === "dispatch.authorized")).toBe(false);
        order.push("observed");
      },
    ]);
    expect(await perform(await replayFrontier(fixture))).toBe("value");
    expect(order).toEqual(["prepare", "observed", "dispatch"]);
    expect(await perform(await replayFrontier(fixture))).toBe("value");
    expect(dispatches).toBe(1);
    expect(order).toEqual(["prepare", "observed", "dispatch"]);
  });

  test("prepares fresh native work but skips preparation and redispatch for its committed replay", async () => {
    const fixture = await replayFixture();
    const request = { trace: ["root", 1], schema: "review/v1", prompt: "native" } satisfies Json;
    const attemptDirectory = join(fixture.runDirectory, "provider-attempts/agent-1");
    let freshPreparations = 0;
    let replayPreparations = 0;
    let qualifications = 0;
    let invocations = 0;
    let dispatches = 0;

    await expect((await replayFrontier(fixture)).perform("agent", request, async () => {
      dispatches += 1;
      return { verdict: "durable" };
    }, () => true, async () => {
      freshPreparations += 1;
      await mkdir(attemptDirectory, { recursive: true });
    })).resolves.toEqual({ verdict: "durable" });

    const service = new ProcessService();
    const adapter: Adapter = {
      async status() { qualifications += 1; throw new Error("RUNTIME_UNQUALIFIED"); },
      invocation(providerRequest) {
        invocations += 1;
        return { executable: "unused", args: [], cwd: providerRequest.workspace, stdin: providerRequest.prompt };
      },
      async capture() { dispatches += 1; throw new Error("must not capture"); },
      async decode() { dispatches += 1; return { structured: { verdict: "redispatched" } }; },
    };
    const providerRequest: ProviderRequest = {
      prompt: "native", schema: { type: "object" }, access: "read", workspace: fixture.root,
      operationDirectory: attemptDirectory, timeoutMs: 1_000,
    };
    try {
      const replayed = await replayFrontier(fixture);
      await expect(dispatchProvider({
        adapter, service, runDirectory: fixture.runDirectory, attemptId: "agent-1", request: providerRequest,
        signal: new AbortController().signal,
        perform: (dispatch, prepare) => replayed.perform("agent", request, dispatch, () => true, prepare),
        async prepare() {
          replayPreparations += 1;
          await mkdir(attemptDirectory);
        },
      })).resolves.toEqual({ verdict: "durable" });
    } finally { await service.dispose(); }

    expect({ freshPreparations, replayPreparations, qualifications, invocations, dispatches }).toEqual({
      freshPreparations: 1, replayPreparations: 0, qualifications: 0, invocations: 0, dispatches: 1,
    });
  });

  test("keeps a cumulative one-command reservation across replay", async () => {
    const fixture = await replayFixture();
    const request = { trace: ["root", 1], schema: "runner-return/v1", executable: "true", args: [] } satisfies Json;
    const frontier = await replayFrontier(fixture);
    await frontier.perform("command", request, async () => ({ exitCode: 0 }));

    const replayed = await replayFrontier(fixture);
    await replayed.perform("command", request, async () => ({ exitCode: 99 }));
    let preparations = 0;
    await expect(replayed.perform("command", {
      trace: ["root", 2], schema: "runner-return/v1", executable: "true", args: [],
    }, async () => ({ exitCode: 0 }), () => true, async () => {
      preparations += 1;
    })).rejects.toThrow("LIMIT_EXCEEDED");

    const history = await readVerifiedEvents(fixture.root, fixture.runId);
    expect(preparations).toBe(0);
    expect(history.filter(({ type }) => type === "operation.prepared")).toHaveLength(1);
  });

  test("dispatches a prepared frontier once but blocks an authorized frontier as unknown", async () => {
    const preparedFixture = await replayFixture();
    const request = { trace: ["root", 1], schema: "review/v1", prompt: "prepared" } satisfies Json;
    const prepared = await preparedFixture.journal.append("operation.prepared", {
      ordinal: 1,
      scope: "root",
      kind: "agent",
      request,
      requestHash: requestHash(request),
      preWorkspaceHash: (JSON.parse(await readFile(join(preparedFixture.runDirectory, "artifacts/workspace-initial.json"), "utf8")) as { sha256: string }).sha256,
      reservation: { commands: 0, agentCalls: 1 },
    });
    let dispatches = 0;
    let preparations = 0;
    await expect((await replayFrontier(preparedFixture)).perform("agent", request, async () => {
      dispatches += 1;
      return { verdict: "prepared-dispatched" };
    }, () => true, async () => {
      preparations += 1;
    })).resolves.toEqual({ verdict: "prepared-dispatched" });
    expect(dispatches).toBe(1);
    expect(preparations).toBe(1);

    const authorizedFixture = await replayFixture();
    const authorizedPrepared = await authorizedFixture.journal.append("operation.prepared", {
      ordinal: 1,
      scope: "root",
      kind: "agent",
      request,
      requestHash: requestHash(request),
      preWorkspaceHash: (JSON.parse(await readFile(join(authorizedFixture.runDirectory, "artifacts/workspace-initial.json"), "utf8")) as { sha256: string }).sha256,
      reservation: { commands: 0, agentCalls: 1 },
    });
    await authorizedFixture.journal.append("dispatch.authorized", { preparedHash: authorizedPrepared.hash, ordinal: 1, kind: "agent" });
    await expect((await replayFrontier(authorizedFixture)).perform("agent", request, async () => {
      dispatches += 1;
      return { verdict: "must-not-run" };
    }, () => true, async () => {
      preparations += 1;
    })).rejects.toThrow("OUTCOME_UNKNOWN");
    expect(dispatches).toBe(1);
    expect(preparations).toBe(1);
    expect(prepared.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("blocks identity trace schema and workspace mismatch before a new effect", async () => {
    const fixture = await replayFixture();
    const request = { trace: ["root", 1], schema: "review/v1", prompt: "exact" } satisfies Json;
    let dispatches = 0;
    let preparations = 0;
    const prepare = async () => { preparations += 1; };
    const frontier = await replayFrontier(fixture);
    await frontier.perform("agent", request, async () => {
      dispatches += 1;
      return { verdict: "pass" };
    });

    await expect(replayFrontier(fixture, { ...replayLimits, maxAgentCalls: 2 })).rejects.toThrow("HISTORY_MISMATCH");
    await expect((await replayFrontier(fixture)).perform("agent", { ...request, trace: ["root", 2] }, async () => {
      dispatches += 1;
      return {};
    }, () => true, prepare)).rejects.toThrow("HISTORY_MISMATCH");
    await expect((await replayFrontier(fixture)).perform("agent", { ...request, schema: "review/v2" }, async () => {
      dispatches += 1;
      return {};
    }, () => true, prepare)).rejects.toThrow("HISTORY_MISMATCH");
    await writeFile(join(fixture.root, "tracked.txt"), "changed\n");
    await expect((await replayFrontier(fixture)).perform("agent", request, async () => {
      dispatches += 1;
      return {};
    }, () => true, prepare)).rejects.toThrow("Workspace is stale");
    expect(dispatches).toBe(1);
    expect(preparations).toBe(0);
  });

  test("blocks hash-valid history identity mismatch and corrupt referenced evidence", async () => {
    const identityFixture = await replayFixture();
    const history = await readVerifiedEvents(identityFixture.root, identityFixture.runId);
    const copiedRun = randomUUID();
    const copiedDirectory = join(identityFixture.root, ".coding-flow/runs", copiedRun);
    await mkdir(copiedDirectory, { recursive: true });
    await expect(ReplayFrontier.open({
      runDirectory: copiedDirectory,
      runId: copiedRun,
      journal: new Journal(copiedDirectory, copiedRun),
      history,
      limits: replayLimits,
    })).rejects.toThrow("HISTORY_MISMATCH");

    const evidenceFixture = await replayFixture();
    await writeFile(join(evidenceFixture.runDirectory, "artifacts/workspace-initial.json"), "{}\n");
    await expect(replayFrontier(evidenceFixture)).rejects.toThrow("EVIDENCE_CORRUPT");

    const historyFixture = await replayFixture();
    const eventsPath = join(historyFixture.runDirectory, "events.jsonl");
    await writeFile(eventsPath, (await readFile(eventsPath, "utf8")).replace('"workspace.captured"', '"operation.committed"'));
    await expect(readVerifiedEvents(historyFixture.root, historyFixture.runId)).rejects.toThrow("Corrupt journal");
  });
});

describe("author primitive composition finalization", () => {
  test.each(["phase", "skill"] as const)("keeps one-effect approval authority inside nested %s scopes", async (kind) => {
    const root = await workspace();
    const child = flow({
      name: "approved-child", description: "Exercises approval authority inside a child flow.",
      input: z.null(), output: z.null(), limits: { maxAgentCalls: 2 },
      async run(context) {
        await context.agent({ name: "first-effect", prompt: "first" });
        await context.agent({ name: "second-effect", prompt: "second" });
        return null;
      },
    });
    const definition = flow({
      name: `approved-${kind}`, description: "Exercises approval authority inside a nested scope.",
      input: z.null(), output: z.null(), limits: { maxAgentCalls: 2 },
      async run(context) {
        return context.human.approve({
          title: "Approve once", presentation: { title: "Approval", markdown: "One effect" }, action: { kind },
        }, async () => kind === "phase"
          ? context.phase("approved", async () => {
              await context.agent({ name: "first-effect", prompt: "first" });
              await context.agent({ name: "second-effect", prompt: "second" });
              return null;
            })
          : context.skill(child, null));
      },
    });
    const approvalRequestId = `approval-${kind}`;
    const effects: (string | undefined)[] = [];

    await expect(runFlow({ definition: definition as unknown as Flow<Json, Json>, input: null }, root, {
      async human(request) {
        return { requestId: approvalRequestId, action: (request as { readonly action: Json }).action };
      },
      async agent(request) {
        effects.push((request as { readonly approvalRequestId?: string }).approvalRequestId);
        return "effect";
      },
    })).rejects.toMatchObject({ code: "APPROVAL_ALREADY_USED" });
    expect(effects).toEqual([approvalRequestId]);
  });

  test("expires approval authority retained by delayed async work", async () => {
    const root = await workspace();
    let release: (() => void) | undefined;
    let delayed: Promise<string> | undefined;
    const definition = flow({
      name: "delayed-approval", description: "Rejects work retained past the approval callback.",
      input: z.null(), output: z.null(), limits: { maxAgentCalls: 1 },
      async run(context) {
        await context.human.approve({
          title: "Approve once", presentation: { title: "Approval", markdown: "One effect" }, action: null,
        }, async () => {
          delayed = new Promise<void>((resolveDelayed) => { release = resolveDelayed; })
            .then(() => context.agent({ name: "delayed-effect", prompt: "delayed" }));
          return null;
        });
        if (!release || !delayed) throw new Error("delayed approval work was not initialized");
        release();
        await delayed;
        return null;
      },
    });
    let dispatches = 0;

    await expect(runFlow({ definition: definition as unknown as Flow<Json, Json>, input: null }, root, {
      async human(request) {
        return { requestId: "approval-delayed", action: (request as { readonly action: Json }).action };
      },
      async agent() { dispatches += 1; return "effect"; },
    })).rejects.toMatchObject({ code: "APPROVAL_SCOPE_EXPIRED" });
    expect(dispatches).toBe(0);
  });

  test("composes reads phases nested flows commands agents instructions checks and logs serially", async () => {
    const root = await workspace();
    await writeFile(join(root, "value.txt"), "workspace-value\n");
    await writeFile(join(root, "instructions.md"), "Follow the local instruction.\n");
    const structured = z.strictObject({ verdict: z.enum(["pass", "fail"]) });
    const child = flow({
      name: "child-review",
      description: "Exercises nested author primitives.",
      input: z.strictObject({ value: z.string() }),
      output: z.strictObject({ combined: z.string() }),
      limits: { maxAgentCalls: 1, maxCommands: 1 },
      disposablePaths: ["scratch"],
      async run(context) {
        const review = await context.agent({
          name: "reviewer", prompt: `Review ${context.input.value}`, instructions: ["instructions.md"], output: structured,
        });
        const command = await context.command("printf", ["ignored"], { cwd: ".", stdin: "input", timeoutMs: 50 });
        context.check(command.exitCode === 0 && review.verdict === "pass", "composition failed");
        context.log("child complete", { review: review.verdict });
        return { combined: `${context.input.value}:${command.stdout}` };
      },
    });
    const definition = flow({
      name: "primitive-root",
      description: "Composes every Slice 8 primitive.",
      input: z.strictObject({ suffix: z.string() }),
      output: z.strictObject({ value: z.string() }),
      limits: { maxAgentCalls: 2, maxCommands: 2 },
      disposablePaths: ["scratch"],
      async run(context) {
        const value = await context.read("value.txt");
        const nested = await context.phase("review", () => context.skill(child, { value: value.trim() }));
        const summary = await context.agent({ name: "summary", prompt: nested.combined });
        return { value: `${nested.combined}:${summary}:${context.input.suffix}` };
      },
    });
    const requests: Json[] = [];
    const logs: string[] = [];
    const result = await runFlow({
      definition: definition as unknown as Flow<Json, Json>, input: { suffix: "done" },
    }, root, {
      async agent(request) {
        requests.push(request);
        const name = (request as { readonly name: string }).name;
        return name === "reviewer" ? { verdict: "pass" } : "summarized";
      },
      async command(request) {
        requests.push(request);
        return { exitCode: 0, stdout: "command", stderr: "", truncated: false,
          stdoutArtifact: placeholderArtifact, stderrArtifact: placeholderArtifact };
      },
      log(message) { logs.push(message); },
    });

    expect(result).toEqual({ value: "workspace-value:command:summarized:done" });
    expect(logs).toEqual(["child complete"]);
    expect(requests.map((request) => (request as { readonly name?: string; readonly schema?: Json }).name ?? (request as { readonly schema: Json }).schema))
      .toHaveLength(3);
    expect(JSON.stringify(requests[0])).toContain("Follow the local instruction.");
    expect(JSON.stringify(requests[0])).toContain("phase:review#1");
    expect(JSON.stringify(requests[0])).toContain("skill:child-review#1");
  });

  test("makes overlapping and caught check failures sticky and rejects pending completion", async () => {
    const root = await workspace();
    await writeFile(join(root, "value.txt"), "value");
    let releaseCommand: (() => void) | undefined;
    const overlap = flow({
      name: "overlap",
      description: "Catches a concurrency error.",
      input: z.null(), output: z.string(),
      async run(context) {
        const command = context.command("hold");
        try { await context.read("value.txt"); } catch {}
        await command;
        return "must-not-succeed";
      },
    });
    const running = runFlow({ definition: overlap as unknown as Flow<Json, Json>, input: null }, root, {
      command: async () => new Promise<Json>((resolveCommand) => {
        releaseCommand = () => resolveCommand({ exitCode: 0, stdout: "", stderr: "", truncated: false,
          stdoutArtifact: placeholderArtifact, stderrArtifact: placeholderArtifact });
      }),
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
    releaseCommand?.();
    await expect(running).rejects.toMatchObject({ code: "CONCURRENT_OPERATION" });

    const caughtCheck = flow({
      name: "caught-check", description: "Catches a failed check.", input: z.null(), output: z.string(),
      async run(context) { try { context.check(false, "bad proof"); } catch {} return "must-not-succeed"; },
    });
    await expect(runFlow({ definition: caughtCheck as unknown as Flow<Json, Json>, input: null }, root))
      .resolves.toBe("must-not-succeed");

    let releasePending: (() => void) | undefined;
    let captured: Promise<unknown> | undefined;
    const pending = flow({
      name: "pending", description: "Returns with pending work.", input: z.null(), output: z.string(),
      async run(context) { captured = context.command("hold"); return "must-not-succeed"; },
    });
    const pendingRun = runFlow({ definition: pending as unknown as Flow<Json, Json>, input: null }, root, {
      command: async () => new Promise<Json>((resolveCommand) => {
        releasePending = () => resolveCommand({ exitCode: 0, stdout: "", stderr: "", truncated: false,
          stdoutArtifact: placeholderArtifact, stderrArtifact: placeholderArtifact });
      }),
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
    releasePending?.();
    await expect(pendingRun).rejects.toMatchObject({ code: "UNAWAITED_OPERATION" });
    await expect(captured).resolves.toBeDefined();

    let releasePhase: (() => void) | undefined;
    const siblingScopes = flow({
      name: "sibling-scopes", description: "Starts overlapping sibling phases.", input: z.null(), output: z.null(),
      async run(context) {
        const first = context.phase("first", async () => new Promise<void>((resolvePhase) => { releasePhase = resolvePhase; }));
        const second = context.phase("second", async () => undefined);
        await Promise.allSettled([first, second]);
        return null;
      },
    });
    const siblingRun = runFlow({ definition: siblingScopes as unknown as Flow<Json, Json>, input: null }, root);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
    releasePhase?.();
    await expect(siblingRun).rejects.toMatchObject({ code: "CONCURRENT_OPERATION" });

    const mixedScope = flow({
      name: "mixed-scope", description: "Rejects a primitive overlapping a structural scope.",
      input: z.null(), output: z.null(),
      async run(context) {
        await Promise.allSettled([
          context.command("true"),
          context.phase("overlap", async () => undefined),
        ]);
        return null;
      },
    });
    await expect(runFlow({ definition: mixedScope as unknown as Flow<Json, Json>, input: null }, root, {
      async command() {
        return { exitCode: 0, stdout: "", stderr: "", truncated: false,
          stdoutArtifact: placeholderArtifact, stderrArtifact: placeholderArtifact };
      },
    })).rejects.toMatchObject({ code: "CONCURRENT_OPERATION" });
  });

  test.each(["APPROVAL_DENIED", "APPROVAL_STALE", "WORKSPACE_CHANGED", "HUMAN_TIMEOUT", "CHECK_FAILED"])("unbranded %s stays sticky and authorizes no later effect", async (code) => {
    const root = await workspace();
    let effects = 0;
    const error = new FlowRuntimeError(code);
    const definition = flow({ name: "lookalike", description: "An error code is not durable consent provenance.", input: z.null(), output: z.null(),
      async run(context) {
        try { await context.human.approve({ title: "First", presentation: { title: "Evidence", markdown: "Body" }, action: null }, async () => null); } catch {}
        try { await context.command("must-not-dispatch"); } catch {}
        return null;
      },
    });
    await expect(runFlow({ definition: definition as unknown as Flow<Json, Json>, input: null }, root, {
      async human() { throw error; }, async command() { effects += 1; return null; },
    })).rejects.toBe(error);
    expect(effects).toBe(0);
  });

  test.each([
    ["invalid phase name", (context: FlowContext<null>) => context.phase("INVALID", async () => undefined), "INVALID_SCOPE_NAME"],
    ["invalid log message", (context: FlowContext<null>) => context.log(""), "LOG_LIMIT"],
  ] as const)("makes caught %s sticky", async (_name, fail, code) => {
    const root = await workspace();
    const definition = flow({
      name: "sticky-validation", description: "Catches a runtime validation failure.", input: z.null(), output: z.string(),
      async run(context) { try { await fail(context); } catch {} return "must-not-succeed"; },
    });

    await expect(runFlow({ definition: definition as unknown as Flow<Json, Json>, input: null }, root))
      .rejects.toMatchObject({ code });
  });

  test.each(["phase", "skill"] as const)("rejects a discarded unsettled %s before finalization", async (kind) => {
    const root = await workspace();
    let done = false;
    const child = flow({
      name: "pending-child", description: "Settles after the parent body returns.",
      input: z.null(), output: z.null(),
      async run() {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        done = true;
        return null;
      },
    });
    const definition = flow({
      name: `discarded-${kind}`, description: "Must not finalize with a pending structural scope.",
      input: z.null(), output: z.null(),
      async run(context) {
        discardForTest(kind === "phase"
          ? context.phase("pending", async () => {
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
              done = true;
            })
          : context.skill(child, null));
        return null;
      },
    });

    await expect(runFlow({ definition: definition as unknown as Flow<Json, Json>, input: null }, root))
      .rejects.toMatchObject({ code: "UNAWAITED_OPERATION" });
    expect(done).toBe(true);
  });

  test("keeps root limits cumulative across repeated child scopes and rejects widening or excess depth", async () => {
    const root = await workspace();
    const child = flow({
      name: "one-command", description: "Uses one command.", input: z.null(), output: z.null(),
      limits: { maxCommands: 1 },
      async run(context) { await context.command("true"); return null; },
    });
    const repeated = flow({
      name: "repeated-child", description: "Repeats a bounded child.", input: z.null(), output: z.null(),
      limits: { maxCommands: 2 },
      async run(context) {
        await context.skill(child, null);
        await context.skill(child, null);
        try { await context.command("third"); } catch {}
        return null;
      },
    });
    let commands = 0;
    const result = () => ({ exitCode: 0, stdout: "", stderr: "", truncated: false,
      stdoutArtifact: placeholderArtifact, stderrArtifact: placeholderArtifact } satisfies Json);
    await expect(runFlow({ definition: repeated as unknown as Flow<Json, Json>, input: null }, root, {
      async command() { commands += 1; return result(); },
    })).rejects.toMatchObject({ code: "COMMAND_LIMIT" });
    expect(commands).toBe(2);

    const wider = flow({
      name: "wider-child", description: "Attempts to widen a parent limit.", input: z.null(), output: z.null(),
      limits: { maxCommands: 2 }, async run() { return null; },
    });
    const narrowRoot = flow({
      name: "narrow-root", description: "Rejects child widening.", input: z.null(), output: z.null(),
      limits: { maxCommands: 1 }, async run(context) { return context.skill(wider, null); },
    });
    await expect(runFlow({ definition: narrowRoot as unknown as Flow<Json, Json>, input: null }, root))
      .rejects.toMatchObject({ code: "CHILD_LIMIT_WIDENED" });

    let nested = flow({
      name: "depth-leaf", description: "Depth leaf.", input: z.null(), output: z.null(), async run() { return null; },
    });
    for (let depth = 0; depth < 9; depth += 1) {
      const next = nested;
      nested = flow({
        name: `depth-${String(depth)}`, description: "Nested depth.", input: z.null(), output: z.null(),
        async run(context) { return context.skill(next, null); },
      });
    }
    await expect(runFlow({ definition: nested as unknown as Flow<Json, Json>, input: null }, root))
      .rejects.toMatchObject({ code: "SKILL_DEPTH" });
  });

  test("replays durable reads and public fake-agent outcomes without a second dispatch", async () => {
    const fixture = await replayFixture({ maxCommands: 0, maxAgentCalls: 1 });
    const request = { trace: ["root", "read", 1], schema: "utf8/v1", path: "tracked.txt" } satisfies Json;
    let reads = 0;
    const first = await replayFrontier(fixture, { maxCommands: 0, maxAgentCalls: 1 });
    await expect(first.perform("read", request, async () => { reads += 1; return "base\n"; })).resolves.toBe("base\n");
    const replayed = await replayFrontier(fixture, { maxCommands: 0, maxAgentCalls: 1 });
    await expect(replayed.perform("read", request, async () => { reads += 1; return "wrong"; })).resolves.toBe("base\n");
    expect(reads).toBe(1);
    const largeRequest = { trace: ["root", "agent", 2], schema: "text/v1", prompt: "x".repeat(300 * 1024) } satisfies Json;
    await expect(replayed.perform("agent", largeRequest, async () => "large request committed"))
      .resolves.toBe("large request committed");
    const largeReadRequest = { trace: ["root", "read", 3], schema: "utf8/v1", path: "large.txt" } satisfies Json;
    const largeRead = "r".repeat(1024 * 1024);
    await expect(replayed.perform("read", largeReadRequest, async () => largeRead)).resolves.toBe(largeRead);
    const largeReplay = await replayFrontier(fixture, { maxCommands: 0, maxAgentCalls: 1 });
    await largeReplay.perform("read", request, async () => "wrong");
    await largeReplay.perform("agent", largeRequest, async () => "wrong");
    await expect(largeReplay.perform("read", largeReadRequest, async () => "wrong")).resolves.toBe(largeRead);
    const lines = (await readFile(join(fixture.runDirectory, "events.jsonl"), "utf8")).trimEnd().split("\n");
    expect(Math.max(...lines.map((line) => Buffer.byteLength(`${line}\n`)))).toBeLessThanOrEqual(256 * 1024);

    const hostRoot = await workspace();
    const entry = join(hostRoot, "agent-flow.mjs");
    await writeFile(entry, `export default {
      kind: "coding-flow/v2", name: "agent-flow", description: "fake agent boundary",
      input: { parse: value => value }, output: { parse: value => value }, limits: { maxAgentCalls: 1 },
      run: async context => ({ answer: await context.agent({ name: "reviewer", prompt: "inspect" }) })
    };\n`);
    const started = await startFlow(pathToFileURL(entry), {}, withTestControl(
      { workspace: hostRoot, runtime }, { fakeAgentResults: ["approved"] },
    ));
    await expect(started.wait(10_000)).resolves.toMatchObject({ status: "succeeded", output: { answer: "approved" } });
    const history = await readVerifiedEvents(hostRoot, started.runId);
    expect(history.filter(({ type }) => type === "operation.prepared")).toHaveLength(1);
    expect(history.filter(({ type }) => type === "operation.committed")).toHaveLength(1);
  }, 15_000);

  test("real two-agent resume replays the first fake outcome and advances to the persisted second outcome", async () => {
    const root = await workspace();
    const entry = join(root, "two-agent-resume.mjs");
    await writeFile(entry, `export default {
      kind: "coding-flow/v2", name: "two-agent-resume", description: "resume fake agents",
      input: { parse: value => value }, output: { parse: value => value }, limits: { maxAgentCalls: 2 },
      run: async context => {
        const first = await context.agent({ name: "first", prompt: "first" });
        await new Promise(resolve => setTimeout(resolve, 1500));
        const second = await context.agent({ name: "second", prompt: "second" });
        return { first, second };
      }
    };\n`);
    const started = await startFlow(pathToFileURL(entry), null, withTestControl(
      { workspace: root, runtime }, { fakeAgentResults: ["configured-first", "configured-second"] },
    ));
    const deadline = Date.now() + 5_000;
    let history: Awaited<ReturnType<typeof readVerifiedEvents>> = [];
    while (!history.some(({ type }) => type === "operation.committed") && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      history = await readVerifiedEvents(root, started.runId);
    }
    expect(history.filter(({ type }) => type === "operation.committed")).toHaveLength(1);
    const created = history[0]?.data as { readonly supervisorPid?: Json };
    expect(typeof created.supervisorPid).toBe("number");
    process.kill(created.supervisorPid as number, "SIGKILL");
    await waitForLockRelease(root);

    const resumed = await resumeRun(root, started.runId);
    await expect(resumed.wait(10_000)).resolves.toMatchObject({
      status: "succeeded",
      output: { first: "configured-first", second: "configured-second" },
    });
    history = await readVerifiedEvents(root, started.runId);
    expect(history.filter(({ type }) => type === "operation.prepared")).toHaveLength(2);
    expect(history.filter(({ type }) => type === "operation.committed")).toHaveLength(2);
  }, 20_000);

  test("replayed reads enforce the public 1 MiB limit before author use", async () => {
    const fixture = await replayFixture({ maxCommands: 0, maxAgentCalls: 0 });
    const request = { trace: ["root", "read", 1], schema: "utf8/v1", path: "tracked.txt" } satisfies Json;
    const oversized = "r".repeat(1024 * 1024 + 1);
    const first = await replayFrontier(fixture, { maxCommands: 0, maxAgentCalls: 0 });
    await expect(first.perform("read", request, async () => oversized)).rejects.toMatchObject({ code: "READ_LIMIT" });
    const replayed = await replayFrontier(fixture, { maxCommands: 0, maxAgentCalls: 0 });
    let authorObserved = false;
    const definition = flow({
      name: "bounded-replayed-read", description: "Rejects oversized durable reads.",
      input: z.null(), output: z.null(),
      async run(context) {
        await context.read("tracked.txt");
        authorObserved = true;
        return null;
      },
    });
    await expect(runFlow({ definition: definition as unknown as Flow<Json, Json>, input: null }, fixture.root, {
      read: async (actual) => replayed.perform("read", actual, async () => "must-not-dispatch"),
    })).rejects.toMatchObject({ code: "READ_LIMIT" });
    expect(authorObserved).toBe(false);
  });

  test("production command honors cwd stdin timeout and publishes output artifacts", async () => {
    const root = await workspace();
    await mkdir(join(root, "nested"));
    const entry = join(root, "command-options.mjs");
    await writeFile(entry, `export default {
      kind: "coding-flow/v2", name: "command-options", description: "command options",
      input: { parse: value => value }, output: { parse: value => value }, limits: { maxCommands: 1 },
      run: async context => context.command(process.execPath, ["--input-type=module", "--eval",
        "const { readFileSync } = await import('node:fs'); console.log(process.cwd()+'|'+readFileSync(0, 'utf8'))"],
        { cwd: "nested", stdin: "payload", timeoutMs: 5000 })
    };\n`);
    const started = await startFlow(pathToFileURL(entry), {}, { workspace: root, runtime });
    const result = await started.wait(15_000);
    expect(result).toMatchObject({ status: "succeeded" });
    if (result.status !== "succeeded") throw new Error("expected success");
    expect(result.output).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("nested|payload"), truncated: false });
    const output = result.output as { readonly stdoutArtifact: { readonly path: string }; readonly stderrArtifact: { readonly path: string } };
    const runDirectory = join(root, ".coding-flow/runs", started.runId);
    await expect(readFile(join(runDirectory, output.stdoutArtifact.path))).resolves.toBeDefined();
    await expect(readFile(join(runDirectory, output.stderrArtifact.path))).resolves.toBeDefined();
  }, 20_000);

  test("enforces the declared cumulative maxStoredBytes before terminal success", async () => {
    const root = await workspace();
    const entry = join(root, "stored-limit.mjs");
    await writeFile(entry, `export default {
      kind: "coding-flow/v2", name: "stored-limit", description: "stored-byte limit",
      input: { parse: value => value }, output: { parse: value => value }, limits: { maxStoredBytes: 1 },
      run: async () => "done"
    };\n`);
    const started = await startFlow(pathToFileURL(entry), null, { workspace: root, runtime });

    await expect(started.wait(10_000)).resolves.toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("LIMIT_EXCEEDED") },
    });
  }, 15_000);

  test("keeps immutable manifest evidence when a rebuildable result projection cannot fit", async () => {
    const run = async (limit: number): Promise<{
      readonly bytes: number;
      readonly resultBytes?: number;
      readonly manifestBefore: Buffer;
      readonly manifestAfter: Buffer;
      readonly terminalTypes: readonly string[];
    }> => {
      const root = await workspace();
      const entry = join(root, "stored-success.mjs");
      await writeFile(entry, `export default {
        kind: "coding-flow/v2", name: "stored-success", description: "terminal storage cap",
        input: { parse: value => value }, output: { parse: value => value },
        limits: { maxStoredBytes: Number("${String(limit).padStart(12, "0")}") },
        run: async () => { await new Promise(resolve => setTimeout(resolve, 100)); return "ok"; }
      };\n`);
      const started = await startFlow(pathToFileURL(entry), null, { workspace: root, runtime });
      const runDirectory = join(root, ".coding-flow", "runs", started.runId);
      const manifestBefore = await readFile(join(runDirectory, "manifest.json"));
      await expect(started.wait(10_000)).resolves.toMatchObject({ status: "succeeded" });
      const resultBytes = await readFile(join(runDirectory, "result.json")).then(
        (bytes) => bytes.length,
        (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error),
      );
      return {
        bytes: await storedBytes(runDirectory),
        ...(resultBytes === undefined ? {} : { resultBytes }),
        manifestBefore,
        manifestAfter: await readFile(join(runDirectory, "manifest.json")),
        terminalTypes: (await readVerifiedEvents(root, started.runId))
          .filter(({ type }) => type === "run.succeeded" || type === "run.failed")
          .map(({ type }) => type),
      };
    };
    const calibration = await run(1_000_000);
    if (calibration.resultBytes === undefined) throw new Error("calibration result projection is missing");
    const cap = calibration.bytes - calibration.resultBytes;

    const boundary = await run(cap);
    expect(boundary.bytes).toBeLessThanOrEqual(cap);
    expect(boundary.manifestAfter).toEqual(boundary.manifestBefore);
    expect(boundary.resultBytes).toBeUndefined();
    expect(boundary.terminalTypes).toEqual(["run.succeeded"]);
  }, 15_000);

  test("blocks terminal success when the final workspace is stale", async () => {
    const root = await workspace();
    const entry = join(root, "final-freshness.mjs");
    await writeFile(entry, `export default {
      kind: "coding-flow/v2", name: "final-freshness", description: "final freshness",
      input: { parse: value => value }, output: { parse: value => value },
      run: async () => { await new Promise(resolve => setTimeout(resolve, 1000)); return { ok: true }; }
    };\n`);
    const started = await startFlow(pathToFileURL(entry), {}, { workspace: root, runtime });
    const deadline = Date.now() + 5_000;
    let history: Awaited<ReturnType<typeof readVerifiedEvents>> = [];
    while (!history.some(({ type }) => type === "workspace.captured") && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      try { history = await readVerifiedEvents(root, started.runId); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "File changed while reading") throw error;
      }
    }
    expect(history.some(({ type }) => type === "workspace.captured")).toBe(true);
    await writeFile(join(root, "external-change.txt"), "stale\n");
    await waitForLockRelease(root);
    expect((await readVerifiedEvents(root, started.runId)).some(({ type }) => type === "run.succeeded" || type === "run.failed")).toBe(false);
  }, 10_000);

  test("rejects unsupported structured-agent contracts before fake dispatch", async () => {
    const root = await workspace();
    const definition = flow({
      name: "agent-contract", description: "Rejects optional agent fields.", input: z.null(), output: z.null(),
      async run(context) {
        await context.agent({ name: "reviewer", prompt: "review", output: z.object({ optional: z.string().optional() }) });
        return null;
      },
    });
    let dispatches = 0;
    await expect(runFlow({ definition: definition as unknown as Flow<Json, Json>, input: null }, root, {
      async agent() { dispatches += 1; return {}; },
    })).rejects.toThrow("properties must be required");
    expect(dispatches).toBe(0);
  });
});
