import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { publishJson, readBoundedFile, verifyArtifact, writeAll, writeDurable } from "../src/artifacts.js";
import { canonicalJson, type Json } from "../src/contracts.js";
import { Journal, readVerifiedEvents } from "../src/journal.js";
import { supervise } from "../src/supervisor.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "coding-flow-storage-"));
  temporary.push(path);
  return path;
}

function createdData(root: string, runId: string): Json {
  const artifact = { path: "artifacts/value.json", sha256: "0".repeat(64), bytes: 0, mediaType: "application/json" };
  return {
    runId,
    entry: "file:///flow.ts",
    workspace: root,
    inputArtifact: artifact,
    bundleArtifact: artifact,
    initializationCharges: { compilations: 1, inputValidations: 0 },
    supervisorPid: 1,
  };
}

describe("durable storage", () => {
  test("writeAll completes short writes", async () => {
    const chunks: Buffer[] = [];
    const writer = {
      async write(bytes: Uint8Array, offset: number, length: number) {
        const written = Math.min(2, length);
        chunks.push(Buffer.from(bytes.subarray(offset, offset + written)));
        return { bytesWritten: written, buffer: bytes };
      },
    };

    await writeAll(writer, Buffer.from("short-write"));
    expect(Buffer.concat(chunks).toString()).toBe("short-write");
  });

  test("rename and directory-sync failures never report publication success", async () => {
    const root = await directory();
    const renamed = join(root, "renamed.json");
    await expect(writeDurable(renamed, Buffer.from("value"), {
      async rename() { throw new Error("rename failed"); },
    })).rejects.toThrow("rename failed");
    await expect(readFile(renamed)).rejects.toMatchObject({ code: "ENOENT" });

    const unsynced = join(root, "unsynced.json");
    await expect(writeDurable(unsynced, Buffer.from("value"), {
      async syncDirectory() { throw new Error("sync failed"); },
    })).rejects.toThrow("sync failed");
    await expect(readFile(unsynced, "utf8")).resolves.toBe("value");
  });

  test("published artifacts are canonical, private, immutable, contained, and verified", async () => {
    const root = await directory();
    const artifacts = join(root, "artifacts");
    await mkdir(artifacts, { mode: 0o700 });
    await expect(publishJson(root, join(root, "manifest.json"), {})).resolves.toHaveProperty("path", "manifest.json");
    const path = join(artifacts, "value.json");
    const artifact = await publishJson(root, path, { z: 1, a: 2 });

    expect(await readFile(path, "utf8")).toBe('{"a":2,"z":1}\n');
    expect((await stat(path)).mode & 0o077).toBe(0);
    await expect(verifyArtifact(root, artifact)).resolves.toEqual(Buffer.from('{"a":2,"z":1}\n'));
    await expect(publishJson(root, path, {})).rejects.toThrow("already exists");
    await expect(publishJson(root, join(root, "../escape.json"), {})).rejects.toThrow("escapes run directory");
  });

  test("artifact verification rejects tampering, oversized metadata, and symlinks", async () => {
    const root = await directory();
    await mkdir(join(root, "artifacts"));
    const bytes = Buffer.from("original\n");
    const artifact = {
      path: "artifacts/value.json",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      mediaType: "application/json",
    };
    await writeFile(join(root, artifact.path), "modified\n");
    await expect(verifyArtifact(root, artifact)).rejects.toThrow("Corrupt journal");
    await expect(verifyArtifact(root, { ...artifact, bytes: 65 * 1024 * 1024 })).rejects.toThrow("Corrupt journal");
    await rm(join(root, artifact.path));
    await symlink("../../outside", join(root, artifact.path));
    await expect(verifyArtifact(root, artifact)).rejects.toThrow("Corrupt journal");
  });

  test("bounded reads reject FIFOs without waiting for a producer", async () => {
    const root = await directory();
    const fifo = join(root, "manifest.json");
    await promisify(execFile)("/usr/bin/mkfifo", [fifo]);
    let settled = false;
    const attempt = readBoundedFile(fifo, 1024)
      .then(() => undefined, (error: unknown) => error)
      .finally(() => { settled = true; });

    await new Promise((resolve) => setTimeout(resolve, 300));
    const settledWithoutProducer = settled;
    if (!settled) {
      const writer = await open(fifo, constants.O_WRONLY);
      await writer.close();
    }

    expect(await attempt).toBeInstanceOf(Error);
    expect(settledWithoutProducer, "FIFO reads must reject without an external writer").toBe(true);
  });

  test("resume rejects matching external manifest symlinks", async () => {
    const root = await directory();
    const outside = await directory();
    const runId = "00000000-0000-4000-8000-000000000044";
    const runDirectory = join(root, ".coding-flow", "runs", runId);
    await mkdir(join(runDirectory, "artifacts"), { recursive: true });
    await mkdir(join(runDirectory, "bundle"));
    const inputArtifact = await publishJson(runDirectory, join(runDirectory, "artifacts", "input.json"), {});
    const bundleBytes = Buffer.from("export default {kind:'coding-flow/v2',input:{parse:x=>x},output:{parse:x=>x},run:async()=>({})};\n");
    await writeFile(join(runDirectory, "bundle", "flow.mjs"), bundleBytes);
    const bundleArtifact = {
      path: "bundle/flow.mjs",
      sha256: createHash("sha256").update(bundleBytes).digest("hex"),
      bytes: bundleBytes.length,
      mediaType: "text/javascript",
    };
    const manifest = {
      runId,
      entry: "file:///flow.ts",
      workspace: root,
      inputArtifact,
      bundleArtifact,
      initializationCharges: { compilations: 1, inputValidations: 0 },
    };
    await new Journal(runDirectory, runId).append("run.created", { ...manifest, supervisorPid: process.pid } as unknown as Json);
    const outsideManifest = join(outside, "manifest.json");
    await writeFile(outsideManifest, JSON.stringify(manifest));
    await symlink(outsideManifest, join(runDirectory, "manifest.json"));

    await expect(supervise({ mode: "resume", workspace: root, runId })).rejects.toThrow();
    await expect(readVerifiedEvents(root, runId)).resolves.toHaveLength(1);
  });

  test("run storage rejects .coding-flow ancestor symlinks", async () => {
    const root = await directory();
    const outside = await directory();
    const runId = "00000000-0000-4000-8000-000000000045";
    const runDirectory = join(outside, "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    await new Journal(runDirectory, runId).append("run.created", createdData(root, runId));
    await symlink(outside, join(root, ".coding-flow"));

    await expect(readVerifiedEvents(root, runId)).rejects.toThrow("Path escapes root");
    await expect(supervise({ mode: "start", entry: "file:///flow.ts", rawInput: {}, workspace: root }))
      .rejects.toThrow("Path escapes root");
    await expect(stat(join(outside, "lock"))).rejects.toMatchObject({ code: "ENOENT" });

    const runsRoot = await directory();
    const outsideRuns = await directory();
    await mkdir(join(runsRoot, ".coding-flow"));
    await symlink(outsideRuns, join(runsRoot, ".coding-flow", "runs"));

    await expect(supervise({ mode: "start", entry: "file:///flow.ts", rawInput: {}, workspace: runsRoot }))
      .rejects.toThrow();
    await expect(readdir(outsideRuns)).resolves.toEqual([]);
  });

  test("supervisor lock creation is private and rejects final symlinks", async () => {
    const root = await directory();
    const runId = "00000000-0000-4000-8000-000000000048";
    const lockPath = join(root, ".coding-flow", "lock");
    const previousUmask = process.umask(0);
    try {
      await expect(supervise({ mode: "resume", workspace: root, runId })).rejects.toThrow();
    } finally {
      process.umask(previousUmask);
    }
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);

    const outside = await directory();
    const target = join(outside, "lock-target");
    await writeFile(target, "unchanged");
    await rm(lockPath);
    await symlink(target, lockPath);

    await expect(supervise({ mode: "resume", workspace: root, runId })).rejects.toMatchObject({ code: "ELOOP" });
    await expect(readFile(target, "utf8")).resolves.toBe("unchanged");
  });

  test("append failures poison the writer and verified recovery rejects torn or corrupt history", async () => {
    const root = await directory();
    const runId = "00000000-0000-4000-8000-000000000041";
    const runDirectory = join(root, ".coding-flow", "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    await symlink("/dev/full", join(runDirectory, "events.jsonl"));
    const failed = new Journal(runDirectory, runId);
    await expect(failed.append("run.created", createdData(root, runId))).rejects.toThrow();
    await expect(failed.append("run.created", createdData(root, runId))).rejects.toThrow("uncertain");

    await rm(join(runDirectory, "events.jsonl"));
    const journal = new Journal(runDirectory, runId);
    await journal.append("run.created", createdData(root, runId));
    const path = join(runDirectory, "events.jsonl");
    const valid = await readFile(path, "utf8");
    await writeFile(path, valid.slice(0, -1));
    await expect(readVerifiedEvents(root, runId)).rejects.toThrow("Incomplete journal append");
    await writeFile(path, valid.replace('"sequence":1', '"sequence":2'));
    await expect(readVerifiedEvents(root, runId)).rejects.toThrow("Corrupt journal");
  });

  test("journal recovery rejects extra blank records", async () => {
    const root = await directory();
    const runId = "00000000-0000-4000-8000-000000000046";
    const runDirectory = join(root, ".coding-flow", "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    await new Journal(runDirectory, runId).append("run.created", createdData(root, runId));
    const path = join(runDirectory, "events.jsonl");
    const valid = await readFile(path);

    await writeFile(path, Buffer.concat([valid, Buffer.from("\n")]));
    await expect(readVerifiedEvents(root, runId)).rejects.toThrow("Corrupt journal");
  });

  test("journal recovery rejects invalid UTF-8 before hash validation", async () => {
    const root = await directory();
    const runId = "00000000-0000-4000-8000-000000000047";
    const runDirectory = join(root, ".coding-flow", "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    const path = join(runDirectory, "events.jsonl");
    const replacement = Buffer.from("�");
    const data = createdData("�", runId);
    await new Journal(runDirectory, runId).append("run.created", data);
    const encoded = await readFile(path);
    const at = encoded.indexOf(replacement);
    expect(at).toBeGreaterThanOrEqual(0);
    await writeFile(path, Buffer.concat([encoded.subarray(0, at), Buffer.from([0xff]), encoded.subarray(at + replacement.length)]));
    await expect(readVerifiedEvents(root, runId)).rejects.toThrow("Corrupt journal");
  });

  test("journal reads are bounded before parsing", async () => {
    const root = await directory();
    const runId = "00000000-0000-4000-8000-000000000042";
    const runDirectory = join(root, ".coding-flow", "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(runDirectory, "events.jsonl"), Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    await expect(readVerifiedEvents(root, runId)).rejects.toThrow("Journal exceeds");
  });

  test("journal publication and recovery enforce the encoded 256 KiB event limit", async () => {
    const root = await directory();
    const runId = "00000000-0000-4000-8000-000000000043";
    const runDirectory = join(root, ".coding-flow", "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    const limit = 256 * 1024;
    const encode = (workspace: string) => {
      const unsigned = {
        version: 2 as const,
        runId,
        sequence: 1,
        ownershipGeneration: 1 as const,
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "run.created" as const,
        data: createdData(workspace, runId),
        previousHash: "0".repeat(64),
      };
      const hash = createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
      return Buffer.from(`${JSON.stringify({ ...unsigned, hash })}\n`);
    };
    const exactWorkspace = "x".repeat(limit - encode("").length);
    expect(encode(exactWorkspace)).toHaveLength(limit);

    const journal = new Journal(runDirectory, runId);
    await journal.append("run.created", createdData(exactWorkspace, runId));
    const path = join(runDirectory, "events.jsonl");
    expect((await readFile(path)).length).toBe(limit);
    await expect(readVerifiedEvents(root, runId)).resolves.toHaveLength(1);

    await expect(journal.append("run.created", createdData(`${exactWorkspace}x`, runId)))
      .rejects.toThrow("Journal event exceeds 256 KiB limit");

    const oversized = encode(`${exactWorkspace}x`);
    expect(oversized).toHaveLength(limit + 1);
    await writeFile(path, oversized);
    await expect(readVerifiedEvents(root, runId)).rejects.toThrow("Journal event exceeds 256 KiB limit");
  });
});
