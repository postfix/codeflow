import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { inspectRecovery, openRun, startFlow, type HumanRequest, type RunBoundary } from "../src/host.js";
import type { Json } from "../src/contracts.js";
import { readVerifiedEvents } from "../src/journal.js";

const temporary: string[] = [];
const runtime = { provider: "codex" as const };
const child = new URL("./fixtures/process-child.mjs", import.meta.url).pathname;
const sdk = fileURLToPath(new URL("../dist/src/sdk.js", import.meta.url));

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codeflow-human-"));
  temporary.push(root);
  await writeFile(join(root, "tracked.txt"), "base\n");
  return root;
}

async function approvalFlow(root: string, body: string, humanTimeoutMs = 5_000): Promise<URL> {
  const entry = join(root, "approval-flow.ts");
  await writeFile(entry, `
    import { flow, z } from ${JSON.stringify(sdk)};
    export default flow({
      name: "approval-flow", description: "Human approval recovery witness.",
      input: z.null(), output: z.json(), limits: { maxCommands: 2, humanTimeoutMs: ${String(humanTimeoutMs)} },
      async run(context) { ${body} },
    });
  `);
  return pathToFileURL(entry);
}

async function waiting(handle: Awaited<ReturnType<typeof startFlow>>) {
  const boundary = await handle.wait(10_000);
  expect(boundary.status, JSON.stringify(boundary)).toBe("waiting-for-human");
  if (boundary.status !== "waiting-for-human") throw new Error("expected human request");
  return boundary.request;
}

function reply(request: HumanRequest, submissionId: string, answer: Json) {
  return {
    requestId: request.requestId, submissionId, revision: request.revision,
    presentationHash: request.presentationHash, answer,
  };
}

async function stopSupervisor(root: string, handle: Awaited<ReturnType<typeof startFlow>>): Promise<void> {
  const history = await readVerifiedEvents(root, handle.runId);
  const created = history[0]?.data as { readonly supervisorPid?: unknown };
  if (typeof created.supervisorPid !== "number") throw new Error("missing supervisor pid");
  process.kill(created.supervisorPid, "SIGKILL");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
}

describe("human approval recovery", () => {
  test("caught durable approval denial opens a distinct revised approval with zero denied effects", async () => {
    const root = await workspace();
    const effect = join(root, "approved-effect");
    const entry = await approvalFlow(root, `
      try {
        await context.human.approve({ title: "First", presentation: { title: "First", markdown: "Reject this revision" }, action: { revision: 1 } },
          async () => { throw new Error("Denied callback ran"); });
      } catch (error) { if (error.code !== "APPROVAL_DENIED") throw error; }
      return context.human.approve({ title: "Revised", presentation: { title: "Revised", markdown: "Approve this revision" }, action: { revision: 2 } },
        async () => { await context.command(process.execPath, ${JSON.stringify([child, "record", effect])}); return "approved"; });
    `);
    const handle = await startFlow(entry, null, { workspace: root, runtime });
    const first = await waiting(handle);
    await handle.respond(reply(first, "deny-first", { decision: "reject", reason: "revise" }));
    const second = await waiting(handle);
    expect(second.requestId).not.toBe(first.requestId);
    await expect(access(effect)).rejects.toMatchObject({ code: "ENOENT" });
    const before = await readVerifiedEvents(root, handle.runId);
    expect(before.filter(({ type }) => String(type) === "approval.gate-denied")).toHaveLength(1);
    expect(before.filter(({ type }) => type === "dispatch.authorized")).toHaveLength(0);
    await handle.respond(reply(second, "approve-revised", { decision: "approve", reason: "approved revision" }));
    await expect(handle.wait(10_000)).resolves.toMatchObject({ status: "succeeded", output: "approved" });
    expect(await readFile(effect, "utf8")).toBe("1");
  }, 20_000);

  test("caught stale presentation permits fresh revision while workspace changes stay blocking", async () => {
    const root = await workspace();
    const effect = join(root, "revised-effect");
    const entry = await approvalFlow(root, `
      const presentation = await context.human.present({ title: "Old evidence", markdown: "Original file", artifacts: [
        { label: "tracked", mediaType: "text/plain", source: { kind: "workspace", path: "tracked.txt" } }
      ] });
      const changed = await context.command(process.execPath, ["--eval", "require('node:fs').writeFileSync('tracked.txt', 'revision')"]);
      context.check(changed.exitCode === 0, changed.stderr);
      try {
        await context.human.approve({ title: "Stale revision", presentation, action: { revision: 1 } }, async () => { throw new Error("Stale callback ran"); });
      } catch (error) { if (error.code !== "APPROVAL_STALE") throw error; }
      return context.human.approve({ title: "Fresh revision", presentation: { title: "Fresh", markdown: "Revision 2" }, action: { revision: 2 } },
        async () => { await context.command(process.execPath, ${JSON.stringify([child, "record", effect])}); return "revised"; });
    `);
    const handle = await startFlow(entry, null, { workspace: root, runtime });
    const first = await waiting(handle);
    await handle.respond(reply(first, "stale-first", { decision: "approve", reason: "old evidence" }));
    const second = await waiting(handle);
    expect(second.requestId).not.toBe(first.requestId);
    const history = await readVerifiedEvents(root, handle.runId);
    expect(history.filter(({ type }) => String(type) === "approval.gate-stale")).toHaveLength(1);
    expect(history.filter(({ type }) => type === "approval.effect-authorized")).toHaveLength(0);
    await handle.respond(reply(second, "fresh-second", { decision: "approve", reason: "fresh evidence" }));
    await expect(handle.wait(10_000)).resolves.toMatchObject({ status: "succeeded", output: "revised" });
    expect(await readFile(effect, "utf8")).toBe("1");
  }, 20_000);

  test.each(["WORKSPACE_CHANGED", "HUMAN_TIMEOUT"])("caught %s remains sticky with no subsequent effect", async (failure) => {
    const root = await workspace();
    const effect = join(root, "must-not-exist");
    const entry = await approvalFlow(root, `
      try { await context.human.approve({ title: "Original", presentation: { title: "Evidence", markdown: "Only this workspace" }, action: null }, async () => null); } catch {}
      try { await context.command(process.execPath, ${JSON.stringify([child, "record", effect])}); } catch {}
      return "must-not-succeed";
    `, failure === "HUMAN_TIMEOUT" ? 500 : 5_000);
    const handle = await startFlow(entry, null, { workspace: root, runtime });
    const request = await waiting(handle);
    if (failure === "WORKSPACE_CHANGED") {
      await writeFile(join(root, "tracked.txt"), "external change");
      await handle.respond(reply(request, "changed-workspace", { decision: "approve", reason: "obsolete" }));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 650));
    }
    await expect(handle.wait(10_000)).resolves.toMatchObject({ status: "failed", error: { message: failure } });
    const history = await readVerifiedEvents(root, handle.runId);
    expect(history.filter(({ type }) => type === "operation.prepared")).toHaveLength(0);
    expect(history.filter(({ type }) => type === "approval.effect-authorized")).toHaveLength(0);
    await expect(access(effect)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("human approval recovery publishes evidence before the request and opens one fresh gate", async () => {
    const root = await workspace();
    const effect = join(root, "effect");
    const entry = await approvalFlow(root, `
      return context.human.approve({
        title: "Write effect", presentation: { title: "Evidence", markdown: "Exact change" }, action: { effect: "once" }, watch: ["tracked.txt"],
      }, async action => {
        const result = await context.command(process.execPath, ${JSON.stringify([child, "record", effect])});
        return { action, exitCode: result.exitCode };
      });
    `);
    const handle = await startFlow(entry, null, { workspace: root, runtime });
    const request = await waiting(handle);
    const inspected: RunBoundary = await inspectRecovery(root, handle.runId);
    expect(inspected).toMatchObject({ status: "waiting-for-human", request: { requestId: request.requestId } });
    const runDirectory = join(root, ".coding-flow/runs", handle.runId);
    await expect(access(join(runDirectory, request.presentation.path))).resolves.toBeUndefined();
    const receipt = await handle.respond(reply(request, "submission-approve", { decision: "approve", reason: "" }));
    expect(receipt.status).toBe("accepted");
    await expect(handle.wait(10_000)).resolves.toMatchObject({ status: "succeeded", output: { action: { effect: "once" }, exitCode: 0 } });
    expect(await readFile(effect, "utf8")).toBe("1");
  }, 20_000);

  test("human approval recovery rejects stale rejected expired and second-use authority", async () => {
    for (const mode of ["reject", "stale", "expired", "second"] as const) {
      const root = await workspace();
      const first = join(root, "first-effect");
      const second = join(root, "second-effect");
      const entry = await approvalFlow(root, `
        return context.human.approve({
          title: "Bounded effect", presentation: { title: "Evidence", markdown: "One effect" }, action: { mode: ${JSON.stringify(mode)} }, watch: ["tracked.txt"],
        }, async () => {
          await context.command(process.execPath, ${JSON.stringify([child, "record", first])});
          await context.command(process.execPath, ${JSON.stringify([child, "record", second])});
          return null;
        });
      `, mode === "expired" ? 500 : 5_000);
      const handle = await startFlow(entry, null, { workspace: root, runtime });
      const request = await waiting(handle);
      await expect(handle.respond(reply(request, "../invalid", { decision: "approve", reason: "" })))
        .resolves.toMatchObject({ status: "invalid" });
      await expect(handle.respond({ ...reply(request, `wrong-${mode}`, { decision: "approve", reason: "" }), requestId: "0".repeat(64) }))
        .resolves.toMatchObject({ status: "invalid" });
      await expect(access(first)).rejects.toMatchObject({ code: "ENOENT" });
      if (mode === "stale") await writeFile(join(root, "tracked.txt"), "changed\n");
      if (mode === "expired") await new Promise((resolve) => setTimeout(resolve, 650));
      const receipt = await handle.respond(reply(request, `submission-${mode}`, {
        decision: mode === "reject" ? "reject" : "approve", reason: "",
      }));
      expect(receipt.status).toBe(mode === "second" ? "accepted" : mode === "expired" ? "already-applied" : "rejected");
      await expect(handle.wait(10_000)).resolves.toMatchObject({ status: "failed" });
      if (mode === "second") expect(await readFile(first, "utf8")).toBe("1");
      else await expect(access(first)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(second)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, 30_000);

  test("human approval recovery deduplicates an old reply after a later request terminal state and reopen", async () => {
    const root = await workspace();
    const entry = await approvalFlow(root, `
      const first = await context.human.ask({ question: "First?", presentation: { title: "First", markdown: "First" }, output: z.string() });
      const second = await context.human.ask({ question: "Second?", presentation: { title: "Second", markdown: "Second" }, output: z.string() });
      return { first, second };
    `);
    const handle = await startFlow(entry, null, { workspace: root, runtime });
    const first = await waiting(handle);
    const firstReply = reply(first, "submission-first", "A");
    const firstReceipt = await handle.respond(firstReply);
    const second = await waiting(handle);
    expect(second.requestId).not.toBe(first.requestId);
    await expect(handle.respond(firstReply)).resolves.toMatchObject({ status: "already-applied" });
    await expect(handle.respond({ ...firstReply, answer: "different" })).resolves.toMatchObject({ status: "rejected" });
    await handle.respond(reply(second, "submission-second", "B"));
    await expect(handle.wait(10_000)).resolves.toMatchObject({ status: "succeeded", output: { first: "A", second: "B" } });
    await expect(handle.respond(firstReply)).resolves.toMatchObject({ status: "already-applied" });
    await expect(openRun(root, handle.runId).respond(firstReply)).resolves.toMatchObject({ status: "already-applied" });
    await expect(openRun(root, handle.runId).respond({
      ...firstReply, submissionId: "submission-conflict", answer: "different",
    })).resolves.toMatchObject({ status: "rejected" });
  }, 20_000);

  test("human approval recovery bounds receipt waiting to five seconds", async () => {
    const root = await workspace();
    const entry = await approvalFlow(root, `
      return context.human.ask({ question: "Reply?", presentation: { title: "Reply", markdown: "Bounded" }, output: z.string() });
    `);
    const handle = await startFlow(entry, null, { workspace: root, runtime });
    const request = await waiting(handle);
    await stopSupervisor(root, handle);
    const startedAt = performance.now();
    await expect(handle.respond(reply(request, "submission-no-receipt", "late")))
      .resolves.toMatchObject({ status: "uncertain" });
    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(5_250);
  }, 12_000);

  test("human approval recovery does not trust a receipt file without a durable decision", async () => {
    const root = await workspace();
    const entry = await approvalFlow(root, `
      return context.human.ask({ question: "Reply?", presentation: { title: "Reply", markdown: "Durable only" }, output: z.string() });
    `);
    const handle = await startFlow(entry, null, { workspace: root, runtime });
    const request = await waiting(handle);
    await stopSupervisor(root, handle);
    const runDirectory = join(root, ".coding-flow/runs", handle.runId);
    await mkdir(join(runDirectory, "receipts"), { recursive: true });
    await writeFile(join(runDirectory, "receipts", "forged.json"), JSON.stringify({
      requestId: request.requestId, submissionId: "forged", status: "accepted",
    }));
    await expect(handle.respond(reply(request, "forged", "forged"))).resolves.toMatchObject({ status: "uncertain" });
    const history = await readVerifiedEvents(root, handle.runId);
    expect(history.some(({ type }) => type === "human.reply-decided")).toBe(false);
  }, 12_000);

  test("human approval recovery rejects a receipt first observed after its deadline", async () => {
    const root = await workspace();
    const entry = await approvalFlow(root, `
      return context.human.ask({ question: "Reply?", presentation: { title: "Reply", markdown: "Deadline" }, output: z.string() });
    `);
    const handle = await startFlow(entry, null, { workspace: root, runtime });
    const request = await waiting(handle);
    await stopSupervisor(root, handle);
    const runDirectory = join(root, ".coding-flow/runs", handle.runId);
    const submissionId = "late-receipt";
    const result = handle.respond(reply(request, submissionId, "late"));
    const inbox = join(runDirectory, "inbox", `${submissionId}.json`);
    while (true) {
      try { await access(inbox); break; }
      catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 5)); }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_005));
    await mkdir(join(runDirectory, "receipts"), { recursive: true });
    await writeFile(join(runDirectory, "receipts", `${submissionId}.json`), JSON.stringify({
      requestId: request.requestId, submissionId, status: "accepted",
    }));
    await expect(result).resolves.toMatchObject({ status: "uncertain" });
  }, 12_000);
});
