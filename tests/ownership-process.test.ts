import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { acquireOwnership } from "../src/ownership.js";
import { ProcessService, readTail } from "../src/process.js";
import { startFlow } from "../src/host.js";
import { executeOwnedCommand } from "../src/supervisor.js";

const services: ProcessService[] = [];
const fixture = new URL("./fixtures/process-child.mjs", import.meta.url).pathname;

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
});

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "codeflow-process-"));
}

describe("authorization ownership process group", () => {
  test("registration is inert, authorization is one-use, and argv stays literal", async () => {
    const root = await directory();
    const effects = join(root, "effects");
    const service = new ProcessService();
    services.push(service);
    const registered = await service.register({
      attemptId: "attempt-one",
      executable: process.execPath,
      args: [fixture, "record", effects, "; touch escaped", "$(false)"],
      cwd: root,
      timeoutMs: 5_000,
      evidenceDirectory: root,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(readFile(effects, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const returned = await service.authorizeTarget(registered, {
      attemptId: registered.attemptId,
      nonce: registered.nonce,
    });
    expect(await readFile(effects, "utf8")).toBe("1");
    expect(JSON.parse(returned.stdout)).toEqual(["; touch escaped", "$(false)"]);
    expect(returned.stderr).toBe("recorded");
    expect(returned.exitCode).toBe(0);
    expect(returned.signal).toBeNull();
    await expect(service.authorizeTarget(registered, {
      attemptId: registered.attemptId,
      nonce: registered.nonce,
    })).rejects.toThrow("already authorized");
    await expect(service.assertGroupAbsent(registered.identity)).resolves.toBeUndefined();
  });

  test("concurrent ownership has one winner and reused identities are only probed", async () => {
    const root = await directory();
    const first = await acquireOwnership(root);
    await expect(acquireOwnership(root)).rejects.toThrow("WORKSPACE_BUSY");
    first.release();
    const second = await acquireOwnership(root);
    second.release();

    const service = new ProcessService();
    services.push(service);
    await expect(service.assertGroupAbsent({ groupId: 2_147_483_647, nonce: "stale" }))
      .resolves.toBeUndefined();
  });

  test("descendants are terminated on cancellation before outcome commit", async () => {
    const root = await directory();
    const marker = join(root, "grandchild.pid");
    const service = new ProcessService();
    services.push(service);
    const registered = await service.register({
      attemptId: "attempt-cancel",
      executable: process.execPath,
      args: [fixture, "hang", marker],
      cwd: root,
      timeoutMs: 10_000,
      evidenceDirectory: root,
    });
    const returned = service.authorizeTarget(registered, {
      attemptId: registered.attemptId,
      nonce: registered.nonce,
    });
    while (true) {
      try { await readFile(marker); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    await service.terminate(registered, "test cancellation");
    const result = await returned;
    expect(result.signal).toBe("SIGTERM");
    await expect(service.assertGroupAbsent(registered.identity)).resolves.toBeUndefined();
  });

  test("supervisor durably authorizes and proves absence before committing", async () => {
    const root = await directory();
    const effects = join(root, "effects");
    const service = new ProcessService();
    services.push(service);
    const result = await executeOwnedCommand({
      service,
      runDirectory: root,
      attemptId: "attempt-supervised",
      executable: process.execPath,
      args: [fixture, "record", effects, "literal"],
      cwd: root,
      timeoutMs: 5_000,
      evidenceDirectory: root,
    });
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(root, "operations", "attempt-supervised.authorized.json"), "utf8"))
      .toContain('"attemptId":"attempt-supervised"');
    expect(await readFile(join(root, "operations", "attempt-supervised.committed.json"), "utf8"))
      .toContain('"exitCode":0');
  });

  test("production supervision owns one literal command and rejects a second dispatch", async () => {
    const root = await directory();
    const effect = join(root, "first-effect");
    const secondEffect = join(root, "second-effect");
    const entry = join(root, "command-flow.mjs");
    await writeFile(entry, `export default {
      kind: "coding-flow/v2",
      name: "owned-command",
      description: "production owned command witness",
      input: { parse: value => value },
      output: { parse: value => value },
      limits: { maxCommands: 2, timeoutMs: 5000 },
      run: async context => {
        const first = await context.command(process.execPath, ${JSON.stringify([fixture, "record", effect, "; touch escaped", "$(false)"])});
        let secondError = "";
        try { await context.command(process.execPath, ${JSON.stringify([fixture, "record", secondEffect])}); }
        catch (error) { secondError = error.message; }
        return { first, secondError };
      },
    };\n`);

    const started = await startFlow(pathToFileURL(entry), {}, { workspace: root });
    await expect(started.wait(15_000)).resolves.toMatchObject({ status: "succeeded" });
    const runDirectory = join(root, ".coding-flow", "runs", started.runId);
    const terminal = JSON.parse(await readFile(join(runDirectory, "result.json"), "utf8"));
    expect(terminal.type).toBe("run.succeeded");
    const output = JSON.parse(await readFile(join(runDirectory, terminal.data.outputArtifact.path), "utf8"));
    expect(output.first.exitCode).toBe(0);
    expect(JSON.parse(output.first.stdout)).toEqual(["; touch escaped", "$(false)"]);
    expect(output.secondError).toBe("COMMAND_LIMIT");
    expect(await readFile(effect, "utf8")).toBe("1");
    await expect(readFile(secondEffect, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    for (const suffix of ["claim", "authorized", "committed"]) {
      await expect(readFile(join(runDirectory, "operations", `command-1.${suffix}.json`))).resolves.toBeDefined();
    }
    const authorization = JSON.parse(await readFile(join(runDirectory, "operations", "command-1.authorized.json"), "utf8"));
    const probe = new ProcessService();
    await expect(probe.assertGroupAbsent({ groupId: authorization.groupId, nonce: authorization.nonce })).resolves.toBeUndefined();
  }, 20_000);

  test("production supervision settles a discarded command before publishing failure", async () => {
    const root = await directory();
    const marker = join(root, "discarded-command.pid");
    const entry = join(root, "discarded-command-flow.mjs");
    await writeFile(entry, `export default {
      kind: "coding-flow/v2",
      name: "discarded-command",
      description: "discarded command cleanup witness",
      input: { parse: value => value },
      output: { parse: value => value },
      limits: { maxCommands: 1, timeoutMs: 30000 },
      run: async context => {
        context.command(process.execPath, ${JSON.stringify([fixture, "hang", marker])});
        throw new Error("flow failed after issuing command");
      },
    };\n`);

    const started = await startFlow(pathToFileURL(entry), {}, { workspace: root });
    await expect(started.wait(15_000)).resolves.toMatchObject({ status: "failed" });
    const runDirectory = join(root, ".coding-flow", "runs", started.runId);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect(readFile(join(runDirectory, "operations", "command-1.authorized.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(runDirectory, "operations", "command-1.committed.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  test("production supervision rejects a command retained past successful flow settlement", async () => {
    const root = await directory();
    const effect = join(root, "late-effect");
    const timerFired = join(root, "late-timer-fired");
    const unhandled = join(root, "late-unhandled-rejection");
    const entry = join(root, "retained-command-flow.mjs");
    await writeFile(entry, `import { writeFile } from "node:fs/promises";
    export default {
      kind: "coding-flow/v2",
      name: "retained-command",
      description: "retained command closure witness",
      input: { parse: value => value },
      output: { parse: value => value },
      limits: { maxCommands: 1, timeoutMs: 5000 },
      run: async context => {
        process.once("unhandledRejection", () => { void writeFile(${JSON.stringify(unhandled)}, "yes"); });
        setTimeout(() => {
          void writeFile(${JSON.stringify(timerFired)}, "yes").catch(() => {});
          context.command(process.execPath, ${JSON.stringify([fixture, "record", effect])});
        }, 250);
        return { ok: true };
      },
    };\n`);

    const started = await startFlow(pathToFileURL(entry), {}, { workspace: root });
    await expect(started.wait(15_000)).resolves.toMatchObject({ status: "succeeded" });
    const runDirectory = join(root, ".coding-flow", "runs", started.runId);
    const initialResult = await readFile(join(runDirectory, "result.json"), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 800));
    await expect(readFile(timerFired, "utf8")).resolves.toBe("yes");
    expect(await readFile(join(runDirectory, "result.json"), "utf8")).toBe(initialResult);
    for (const suffix of ["claim", "registered", "authorized", "committed"]) {
      await expect(readFile(join(runDirectory, "operations", `command-1.${suffix}.json`)))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(readFile(effect)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(unhandled)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  test("initial waits tolerate live journal growth but still reject permanent corruption", async () => {
    for (let index = 0; index < 20; index += 1) {
      const root = await directory();
      const entry = join(root, "polling-flow.mjs");
      await writeFile(entry, `export default {
        kind: "coding-flow/v2",
        input: { parse: value => value },
        output: { parse: value => value },
        run: async () => ({ ok: true })
      };\n`);
      const started = await startFlow(pathToFileURL(entry), {}, { workspace: root });
      await expect(started.wait(10_000)).resolves.toMatchObject({ status: "succeeded" });
      if (index === 0) {
        const journal = join(root, ".coding-flow", "runs", started.runId, "events.jsonl");
        await writeFile(journal, Buffer.concat([await readFile(journal), Buffer.from("not-json\n")]));
        await expect(started.wait(100)).rejects.toThrow("Corrupt journal");
      }
    }
  }, 60_000);

  test("an attempt is claimed once before any second command effect", async () => {
    const root = await directory();
    const effects = join(root, "effects");
    const service = new ProcessService();
    services.push(service);
    const context = {
      service,
      runDirectory: root,
      attemptId: "attempt-once",
      executable: process.execPath,
      args: [fixture, "record", effects, "literal"],
      cwd: root,
      timeoutMs: 5_000,
      evidenceDirectory: root,
    } as const;

    await expect(executeOwnedCommand(context)).resolves.toMatchObject({ exitCode: 0 });
    const authorizationPath = join(root, "operations", "attempt-once.authorized.json");
    const authorization = await readFile(authorizationPath, "utf8");
    await expect(executeOwnedCommand(context)).rejects.toThrow("ATTEMPT_EXISTS");
    expect(await readFile(effects, "utf8")).toBe("1");
    expect(await readFile(authorizationPath, "utf8")).toBe(authorization);
  });

  test("bounded return evidence caps a fast 64 MiB plus one byte burst", async () => {
    const root = await directory();
    const service = new ProcessService();
    services.push(service);
    const registered = await service.register({
      attemptId: "bounded-output",
      executable: process.execPath,
      args: [fixture, "output", String(64 * 1024 * 1024 + 1)],
      cwd: root,
      timeoutMs: 5_000,
      evidenceDirectory: root,
    });
    const returned = await service.authorizeTarget(registered, {
      attemptId: registered.attemptId,
      nonce: registered.nonce,
    });
    expect(returned.truncated).toBe(true);
    expect(returned.error).toBe("OUTPUT_LIMIT");
    expect(Buffer.byteLength(returned.stdout)).toBe(64 * 1024);
    const stdoutBytes = returned.stdoutPath ? (await readFile(returned.stdoutPath)).length : 0;
    const stderrBytes = returned.stderrPath ? (await readFile(returned.stderrPath)).length : 0;
    expect(stdoutBytes + stderrBytes).toBe(64 * 1024 * 1024);
  }, 15_000);

  test("output-limit cleanup finalizes evidence before killing a resistant writer group", async () => {
    const root = await directory();
    const service = new ProcessService();
    services.push(service);
    const registered = await service.register({
      attemptId: "resistant-output",
      executable: process.execPath,
      args: [fixture, "resistant-output"],
      cwd: root,
      timeoutMs: 10_000,
      evidenceDirectory: root,
    });
    const returned = await service.authorizeTarget(registered, {
      attemptId: registered.attemptId,
      nonce: registered.nonce,
    });
    expect(returned.error).toBe("OUTPUT_LIMIT");
    expect(returned.truncated).toBe(true);
    const stdoutBytes = returned.stdoutPath ? (await readFile(returned.stdoutPath)).length : 0;
    const stderrBytes = returned.stderrPath ? (await readFile(returned.stderrPath)).length : 0;
    expect(stdoutBytes + stderrBytes).toBe(64 * 1024 * 1024);
    await expect(service.assertGroupAbsent(registered.identity)).resolves.toBeUndefined();
  }, 15_000);

  test("output evidence is finalized after an inherited-descriptor writer is dead", async () => {
    const root = await directory();
    const service = new ProcessService();
    services.push(service);
    const registered = await service.register({
      attemptId: "inherited-output",
      executable: process.execPath,
      args: [fixture, "inherited-output"],
      cwd: root,
      timeoutMs: 10_000,
      evidenceDirectory: root,
    });
    const returned = await service.authorizeTarget(registered, {
      attemptId: registered.attemptId,
      nonce: registered.nonce,
    });
    expect(returned.error).toBe("OUTPUT_LIMIT");
    expect(returned.truncated).toBe(true);
    expect(Buffer.byteLength(returned.stdout)).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(returned.stderr)).toBeLessThanOrEqual(64 * 1024);
    const stdoutBytes = returned.stdoutPath ? (await readFile(returned.stdoutPath)).length : 0;
    const stderrBytes = returned.stderrPath ? (await readFile(returned.stderrPath)).length : 0;
    expect(stdoutBytes + stderrBytes).toBe(64 * 1024 * 1024);
    await expect(service.assertGroupAbsent(registered.identity)).resolves.toBeUndefined();
  }, 15_000);

  test("dual-stream raw truncation does not invent a UTF-8 replacement character", async () => {
    const root = await directory();
    const service = new ProcessService();
    services.push(service);
    const registered = await service.register({
      attemptId: "dual-utf8",
      executable: process.execPath,
      args: [fixture, "dual-utf8"],
      cwd: root,
      timeoutMs: 10_000,
      evidenceDirectory: root,
    });
    const returned = await service.authorizeTarget(registered, {
      attemptId: registered.attemptId,
      nonce: registered.nonce,
    });
    expect(returned.error).toBe("OUTPUT_LIMIT");
    expect(returned.truncated).toBe(true);
    expect(returned.stdout).not.toContain("�");
    expect(returned.stderr).not.toContain("�");
    expect(Buffer.byteLength(returned.stdout)).toBe(65_535);
    expect(Buffer.byteLength(returned.stderr)).toBe(65_536);
    const stdoutBytes = returned.stdoutPath ? (await readFile(returned.stdoutPath)).length : 0;
    const stderrBytes = returned.stderrPath ? (await readFile(returned.stderrPath)).length : 0;
    expect(stdoutBytes + stderrBytes).toBe(64 * 1024 * 1024);
    await expect(service.assertGroupAbsent(registered.identity)).resolves.toBeUndefined();
  }, 15_000);

  test("bounded return evidence keeps a valid UTF-8 tail without splitting code points", async () => {
    const root = await directory();
    const service = new ProcessService();
    services.push(service);
    const registered = await service.register({
      attemptId: "utf8-tail",
      executable: process.execPath,
      args: ["-e", 'process.stdout.write("€".repeat(21846))'],
      cwd: root,
      timeoutMs: 5_000,
      evidenceDirectory: root,
    });
    const returned = await service.authorizeTarget(registered, {
      attemptId: registered.attemptId,
      nonce: registered.nonce,
    });
    expect(returned.truncated).toBe(true);
    expect(Buffer.byteLength(returned.stdout, "utf8")).toBe(65_535);
    expect(returned.stdout).toBe("€".repeat(21_845));
    expect(returned.stdout).not.toContain("�");
  });

  test("malformed UTF-8 omission is reported when the raw file exactly fills the tail", async () => {
    const root = await directory();
    const service = new ProcessService();
    services.push(service);
    const registered = await service.register({
      attemptId: "malformed-tail",
      executable: process.execPath,
      args: ["-e", "process.stdout.write(Buffer.alloc(65536, 0x80))"],
      cwd: root,
      timeoutMs: 5_000,
      evidenceDirectory: root,
    });
    const returned = await service.authorizeTarget(registered, {
      attemptId: registered.attemptId,
      nonce: registered.nonce,
    });
    expect(returned.truncated).toBe(true);
    expect(Buffer.byteLength(returned.stdout, "utf8")).toBe(65_535);
    expect(returned.stdout).toBe("�".repeat(21_845));
  });

  test("cut-tail UTF-8 classification omits only canonical incomplete prefixes", async () => {
    const path = join(await directory(), "tail.raw");
    const cases = [
      { bytes: [0xc2], omitted: true },
      { bytes: [0xe0, 0xa0], omitted: true },
      { bytes: [0xed, 0x9f], omitted: true },
      { bytes: [0xf0, 0x90, 0x80], omitted: true },
      { bytes: [0xf4, 0x8f, 0x80], omitted: true },
      { bytes: [0xe0, 0x80], omitted: false },
      { bytes: [0xed, 0xa0], omitted: false },
      { bytes: [0xf0, 0x80], omitted: false },
      { bytes: [0xf4, 0x90], omitted: false },
    ] as const;
    for (const current of cases) {
      const bytes = Buffer.from([0x78, ...current.bytes]);
      await writeFile(path, bytes);
      const descriptor = openSync(path, "r");
      try {
        const tail = readTail(descriptor, bytes.length, true);
        expect(tail.omitted).toBe(current.omitted);
        expect(tail.text.includes("�")).toBe(!current.omitted);
      } finally {
        closeSync(descriptor);
      }
    }
  });
});
