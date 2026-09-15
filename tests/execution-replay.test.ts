import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import type { Json } from "../src/contracts.js";
import { openRun, resumeRun, startFlow } from "../src/host.js";
import { Journal, readVerifiedEvents } from "../src/journal.js";
import { withTestControl } from "../src/testing.js";

const exec = promisify(execFile);
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "coding-flow-"));
  temporary.push(path);
  return path;
}

async function launchAndExit(entry: URL, root: string): Promise<string> {
  const host = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "../dist/src/host.js"));
  const source = `
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { startFlow } from ${JSON.stringify(host.href)};
    const handle = await startFlow(new URL(process.env.FLOW_ENTRY), JSON.parse(process.env.FLOW_INPUT), {
      workspace: process.env.FLOW_WORKSPACE,
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
    const entry = new URL("./fixtures/host-flow.ts", import.meta.url);
    const root = await workspace();
    const started = await startFlow(entry, { message: "durable", delayMs: 300 }, { workspace: root });
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

    const started = await startFlow(pathToFileURL(entry), {}, { workspace: root });
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

    const started = await startFlow(pathToFileURL(entry), {}, { workspace: root });
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
    const entry = new URL("./fixtures/host-flow.ts", import.meta.url);
    const root = await workspace();

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
    const invalid = await startFlow(entry, { message: 42, delayMs: 0 }, { workspace: invalidRoot });
    await expect(invalid.wait(10_000)).resolves.toMatchObject({ status: "failed" });
    await expect(open(join(invalidRoot, "body-effects.txt"), "r")).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  test("initialization and contract resume preserves pinned identity and charges", async () => {
    const entry = new URL("./fixtures/host-flow.ts", import.meta.url);
    const root = await workspace();
    const started = await startFlow(entry, { message: "resumed", delayMs: 0 }, withTestControl(
      { workspace: root },
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
    const entry = new URL("./fixtures/host-flow.ts", import.meta.url);
    const root = await workspace();
    const started = await startFlow(entry, { message: "original", delayMs: 0 }, withTestControl(
      { workspace: root },
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

    await expect(openRun(root, runId).wait(100)).rejects.toThrow("Corrupt journal");
  });

  test("waits for the supervisor handshake without an arbitrary timeout", async () => {
    const entry = new URL("./fixtures/host-flow.ts", import.meta.url);
    const root = await workspace();
    const starting = startFlow(entry, { message: "durable", delayMs: 0 }, { workspace: root });

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_100);

    await expect(starting).resolves.toHaveProperty("runId");
  }, 10_000);
});
