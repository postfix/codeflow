import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ProcessService } from "../src/process.js";

const fixture = new URL("./fixtures/process-child.mjs", import.meta.url).pathname;
const runner = new URL("../dist/src/runner.js", import.meta.url).pathname;

function waitForMessage(child: ReturnType<typeof fork>, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => child.on("message", (message) => {
    if (typeof message === "object" && message !== null && "type" in message && message.type === type) {
      resolve(message as Record<string, unknown>);
    }
  }));
}

async function waitForFile(path: string): Promise<void> {
  while (true) {
    try { await readFile(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
}

describe("authorization ownership process group crash matrix", () => {
  test("disposal closes registration and waits for a starting runner to exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeflow-registration-dispose-"));
    const marker = join(root, "starting-runner.pid");
    process.env.CODEFLOW_TEST_RUNNER_PID = marker;
    try {
      const service = new ProcessService(fixture, 5_000);
      const registration = service.register({
        attemptId: "registration-dispose",
        executable: process.execPath,
        args: [fixture, "record", join(root, "effects")],
        cwd: root,
        timeoutMs: 5_000,
        evidenceDirectory: root,
      });
      await waitForFile(marker);
      const pid = Number(await readFile(marker, "utf8"));
      await service.dispose();
      await expect(registration).rejects.toThrow();
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(service.register({
        attemptId: "registration-after-dispose",
        executable: process.execPath,
        args: [fixture, "record", join(root, "later-effects")],
        cwd: root,
        timeoutMs: 5_000,
        evidenceDirectory: root,
      })).rejects.toThrow("disposed");
    } finally {
      delete process.env.CODEFLOW_TEST_RUNNER_PID;
    }
  });

  test("registration timeout reaps the detached inert runner before rejecting", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeflow-registration-timeout-"));
    const marker = join(root, "inert-runner.pid");
    process.env.CODEFLOW_TEST_RUNNER_PID = marker;
    try {
      const service = new ProcessService(fixture, 500);
      await expect(service.register({
        attemptId: "registration-timeout",
        executable: process.execPath,
        args: [fixture, "record", join(root, "effects")],
        cwd: root,
        timeoutMs: 5_000,
        evidenceDirectory: root,
      })).rejects.toThrow("registration timed out");
      const pid = Number(await readFile(marker, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      delete process.env.CODEFLOW_TEST_RUNNER_PID;
    }
  });

  test("runner loss leaves no authority to signal a reused group", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeflow-crash-"));
    const service = new ProcessService();
    const registered = await service.register({
      attemptId: "runner-loss",
      executable: process.execPath,
      args: [fixture, "record", join(root, "effects")],
      cwd: root,
      timeoutMs: 5_000,
      evidenceDirectory: root,
    });
    await service.terminate(registered, "runner lost before authorization");
    await expect(readFile(join(root, "effects"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(service.assertGroupAbsent(registered.identity)).resolves.toBeUndefined();
    await service.dispose();
  });

  test("parent-channel loss cleans the live runner group", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeflow-parent-loss-"));
    const marker = join(root, "grandchild.pid");
    const nonce = randomUUID();
    const child = fork(runner, [nonce], { detached: true, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const ready = await waitForMessage(child, "ready");
    child.send({
      type: "execute",
      nonce,
      attemptId: "parent-loss",
      executable: process.execPath,
      args: [fixture, "hang", marker],
      cwd: root,
      timeoutMs: 10_000,
      evidenceDirectory: root,
    });
    await waitForFile(marker);
    child.disconnect();
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const service = new ProcessService();
    await expect(service.assertGroupAbsent({ groupId: Number(ready.groupId), nonce })).resolves.toBeUndefined();
  });

  test("killed runner leaves a conservative block and recovery sends no signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeflow-runner-loss-"));
    const marker = join(root, "grandchild.pid");
    const service = new ProcessService();
    const registered = await service.register({
      attemptId: "killed-runner",
      executable: process.execPath,
      args: [fixture, "hang", marker],
      cwd: root,
      timeoutMs: 10_000,
      evidenceDirectory: root,
    });
    const returned = service.authorizeTarget(registered, { attemptId: registered.attemptId, nonce: registered.nonce });
    await waitForFile(marker);
    registered.child.kill("SIGKILL");
    await expect(returned).rejects.toThrow("without return evidence");
    const originalKill = process.kill;
    const signals: Array<number | NodeJS.Signals | undefined> = [];
    process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      signals.push(signal);
      return originalKill(pid, signal);
    }) as typeof process.kill;
    try {
      await expect(service.assertGroupAbsent(registered.identity, 50)).rejects.toThrow("OWNER_UNVERIFIED");
      expect(signals.every((value) => value === 0)).toBe(true);
    } finally {
      process.kill = originalKill;
      try { process.kill(-registered.groupId, "SIGKILL"); } catch {}
    }
    await service.dispose();
  });

  test("normal completion escalates cleanup for a SIGTERM-resistant descendant", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeflow-resistant-descendant-"));
    const marker = join(root, "resistant.pid");
    const service = new ProcessService();
    let descendant = 0;
    try {
      const registered = await service.register({
        attemptId: "resistant-descendant",
        executable: process.execPath,
        args: [fixture, "resistant", marker],
        cwd: root,
        timeoutMs: 10_000,
        evidenceDirectory: root,
      });
      const returned = service.authorizeTarget(registered, {
        attemptId: registered.attemptId,
        nonce: registered.nonce,
      });
      await waitForFile(marker);
      descendant = Number(await readFile(marker, "utf8"));
      await expect(returned).resolves.toMatchObject({ exitCode: 0 });
      await expect(service.assertGroupAbsent(registered.identity)).resolves.toBeUndefined();
      expect(() => process.kill(descendant, 0)).toThrow();
    } finally {
      if (descendant > 1) try { process.kill(descendant, "SIGKILL"); } catch {}
      await service.dispose();
    }
  }, 12_000);
});
