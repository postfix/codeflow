import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import {
  inspectRecovery,
  listRuns,
  openRun,
  resumeRun,
  startFlow,
  type BlockCode,
  type FlowErrorData,
  type HumanReply,
  type HumanRequest,
  type ReplyReceipt,
  type RunBoundary,
  type RunOptions,
  type RunSummary,
  type RuntimeConfig,
} from "../src/host.js";
import { Journal, readVerifiedEvents } from "../src/journal.js";
import { publishJson } from "../src/artifacts.js";

const runtime: RuntimeConfig = { provider: "codex", executable: "codex", model: "test" };

function publicTypes(
  options: RunOptions,
  request: HumanRequest,
  reply: HumanReply,
  receipt: ReplyReceipt,
  summary: RunSummary,
  boundary: RunBoundary,
  block: BlockCode,
  error: FlowErrorData,
): void {
  void [options, request, reply, receipt, summary, boundary, block, error];
}
void publicTypes;

async function workspace(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `codeflow-host-${name}-`));
}

async function entry(root: string, body = "return { ok: true };"): Promise<URL> {
  const sdk = new URL("../dist/src/sdk.js", import.meta.url).pathname;
  const path = join(root, "flow.ts");
  await writeFile(path, `
    import { flow, z } from ${JSON.stringify(sdk)};
    export default flow({ name: "host-contract", description: "Host contract witness.",
      input: z.null(), output: z.json(), async run(context) { ${body} } });
  `);
  return pathToFileURL(path);
}

describe("normative host contract", () => {
  test("projects one truthful summary for wait, inspection, open, and listing", async () => {
    const root = await workspace("summary");
    const started = await startFlow(await entry(root), null, { workspace: root, runtime });
    const terminal = await started.wait(10_000);
    expect(terminal).toMatchObject({
      version: 2,
      runId: started.runId,
      flowName: "host-contract",
      attempt: 1,
      agentCalls: 0,
      commands: 0,
      activeMsCharged: 0,
      partialEffectsPossible: false,
      status: "succeeded",
    });
    expect(terminal.entry).toBe((await entry(root)).href);
    expect(terminal.evidenceDirectory).toBe(join(root, ".coding-flow", "runs", started.runId));
    await expect((await openRun(root, started.runId)).wait(0)).resolves.toEqual(terminal);
    await expect(inspectRecovery(root, started.runId)).resolves.toEqual(terminal);
    await expect(listRuns(root)).resolves.toEqual([terminal]);
  });

  test("commits attempt one before start and a later attempt before resume returns", async () => {
    const root = await workspace("attempt");
    const started = await startFlow(await entry(root, "await new Promise(() => {});"), null, {
      workspace: root,
      runtime,
    });
    const before = await readVerifiedEvents(root, started.runId);
    expect(before[0]?.type).toBe("run.created");
    expect(before[0]?.data).toMatchObject({ attempt: 1 });
    await expect(started.cancel("host contract cleanup")).resolves.toMatchObject({ status: "cancelled" });
  });

  test("rejects resume after durable cancellation without appending another attempt", async () => {
    const root = await workspace("cancelled-resume");
    const started = await startFlow(await entry(root, "await new Promise(() => {});"), null, {
      workspace: root,
      runtime,
    });
    await expect(started.cancel("terminal cancellation")).resolves.toMatchObject({ status: "cancelled" });
    const terminalHistory = await readVerifiedEvents(root, started.runId);

    await expect(resumeRun(root, started.runId)).rejects.toThrow("Run is not resumable");
    await expect(readVerifiedEvents(root, started.runId)).resolves.toEqual(terminalHistory);
  });

  test("publishes exact question identity and immutable presentation before accepting a reply", async () => {
    const root = await workspace("human");
    const started = await startFlow(await entry(root, `
      const answer = await context.human.ask({
        question: "Choose", presentation: { title: "Evidence", markdown: "Immutable" },
        output: z.strictObject({ choice: z.enum(["a", "b"]) }),
      });
      return answer;
    `), null, { workspace: root, runtime });
    const waiting = await started.wait(10_000);
    expect(waiting.status).toBe("waiting-for-human");
    if (waiting.status !== "waiting-for-human") throw new Error("expected question");
    expect(waiting.request).toMatchObject({ kind: "question", title: "Choose" });
    const presentation = join(waiting.evidenceDirectory, waiting.request.presentation.path);
    await expect(readFile(presentation)).resolves.toBeDefined();
    const receipt = await started.respond({
      submissionId: "host-question-1",
      requestId: waiting.request.requestId,
      revision: waiting.request.revision,
      presentationHash: waiting.request.presentationHash,
      answer: { choice: "a" },
    });
    expect(receipt).toEqual({ submissionId: "host-question-1", status: "accepted" });
    await expect(started.wait(10_000)).resolves.toMatchObject({ status: "succeeded", output: { choice: "a" } });
  });

  test("resolves both concurrent replies with truthful receipts", async () => {
    const root = await workspace("concurrent-replies");
    const started = await startFlow(await entry(root, `
      return await context.human.ask({
        question: "Choose", presentation: { title: "Evidence", markdown: "Immutable" },
        output: z.enum(["a", "b"]),
      });
    `), null, { workspace: root, runtime });
    const waiting = await started.wait(10_000);
    if (waiting.status !== "waiting-for-human") throw new Error("expected question");
    const base = {
      requestId: waiting.request.requestId,
      revision: waiting.request.revision,
      presentationHash: waiting.request.presentationHash,
    };

    const receipts = await Promise.all([
      started.respond({ ...base, submissionId: "a-winner", answer: "a" }),
      started.respond({ ...base, submissionId: "z-loser", answer: "b" }),
    ]);

    expect(receipts).toEqual([
      { submissionId: "a-winner", status: "accepted" },
      { submissionId: "z-loser", status: "rejected" },
    ]);
    await expect(started.wait(10_000)).resolves.toMatchObject({ status: "succeeded", output: "a" });
  });

  test("accepts a question answer matching one anyOf branch", async () => {
    const root = await workspace("union-answer");
    const started = await startFlow(await entry(root, `
      return await context.human.ask({
        question: "String or number", presentation: { title: "Union", markdown: "Choose a type" },
        output: z.union([z.string(), z.number()]),
      });
    `), null, { workspace: root, runtime });
    const waiting = await started.wait(10_000);
    if (waiting.status !== "waiting-for-human") throw new Error("expected question");

    await expect(started.respond({
      submissionId: "union-number",
      requestId: waiting.request.requestId,
      revision: waiting.request.revision,
      presentationHash: waiting.request.presentationHash,
      answer: 42,
    })).resolves.toEqual({ submissionId: "union-number", status: "accepted" });
    await expect(started.wait(10_000)).resolves.toMatchObject({ status: "succeeded", output: 42 });
  });

  test("enforces every supported constraint in a published question schema", async () => {
    const root = await workspace("question-constraints");
    const started = await startFlow(await entry(root, `
      return await context.human.ask({
        question: "Constrained", presentation: { title: "Constraints", markdown: "Exact contract" },
        output: z.strictObject({
          text: z.string().min(3).max(4).regex(/^a+$/),
          count: z.number().int().min(2).max(4).multipleOf(2),
          items: z.array(z.string()).min(1).max(2),
          kind: z.literal("ok"),
        }),
      });
    `), null, { workspace: root, runtime });
    const waiting = await started.wait(10_000);
    if (waiting.status !== "waiting-for-human") throw new Error("expected question");
    const reply = (submissionId: string, answer: HumanReply["answer"]): HumanReply => ({
      submissionId, requestId: waiting.request.requestId, revision: waiting.request.revision,
      presentationHash: waiting.request.presentationHash, answer,
    });
    const valid = { text: "aaa", count: 4, items: ["one"], kind: "ok" };
    const invalid = [
      { ...valid, text: "a" },
      { ...valid, text: "bbb" },
      { ...valid, text: "aaaaa" },
      { ...valid, count: 1 },
      { ...valid, count: 3 },
      { ...valid, count: 6 },
      { ...valid, items: [] },
      { ...valid, items: ["one", "two", "three"] },
      { ...valid, kind: "not-ok" },
    ];
    for (const [index, answer] of invalid.entries()) {
      await expect(started.respond(reply(`invalid-${String(index)}`, answer))).resolves.toMatchObject({ status: "invalid" });
    }
    await expect(started.respond(reply("constraints-valid", valid))).resolves.toEqual({
      submissionId: "constraints-valid", status: "accepted",
    });
    await expect(started.wait(10_000)).resolves.toMatchObject({ status: "succeeded", output: valid });
  });

  test("rejects regex flags before publishing a human request", async () => {
    const root = await workspace("regex-flags");
    const started = await startFlow(await entry(root, `
      return await context.human.ask({
        question: "Flagged", presentation: { title: "Flagged regex", markdown: "Cannot lose flags" },
        output: z.string().regex(/abc/i),
      });
    `), null, { workspace: root, runtime });

    await expect(started.wait(10_000)).resolves.toMatchObject({ status: "failed" });
    expect((await readVerifiedEvents(root, started.runId)).some(({ type }) => type === "human.requested")).toBe(false);
  });

  test("validates multipleOf exactly from JSON number spellings", async () => {
    const root = await workspace("multiple-of");
    const cases = [
      { divisor: 0.1, answer: 0.3, accepted: true },
      { divisor: 1e-4, answer: 3e-4, accepted: true },
      { divisor: 0.2, answer: -0.6, accepted: true },
      { divisor: 7, answer: 0, accepted: true },
      { divisor: 3e-200, answer: 0.1, accepted: false },
    ] as const;
    const started = await startFlow(await entry(root, `
      const answers = [];
      for (const item of ${JSON.stringify(cases)}) answers.push(await context.human.ask({
        question: "Exact multiple", presentation: { title: "Exact", markdown: "Decimal rational" },
        output: z.number().multipleOf(item.divisor),
      }));
      return answers;
    `), null, { workspace: root, runtime });

    for (const [index, item] of cases.entries()) {
      const waiting = await started.wait(10_000);
      if (waiting.status !== "waiting-for-human") throw new Error("expected exact-number question");
      const base = {
        requestId: waiting.request.requestId, revision: waiting.request.revision,
        presentationHash: waiting.request.presentationHash,
      };
      await expect(started.respond({ ...base, submissionId: `multiple-${String(index)}`, answer: item.answer }))
        .resolves.toMatchObject({ status: item.accepted ? "accepted" : "invalid" });
    }
    await expect(started.cancel("exact multiple witness complete")).resolves.toMatchObject({ status: "cancelled" });
  }, 20_000);

  test("projects exact public input and output error codes and rejects impossible durable codes", async () => {
    const root = await workspace("error-codes");
    const sdk = new URL("../dist/src/sdk.js", import.meta.url).pathname;
    const path = join(root, "contract-errors.ts");
    await writeFile(path, `
      import { flow, z } from ${JSON.stringify(sdk)};
      export default flow({ name: "contract-errors", description: "Exact public errors.",
        input: z.strictObject({ valid: z.boolean() }), output: z.strictObject({ valid: z.boolean() }),
        async run() { return { valid: "not-a-boolean" }; } });
    `);
    const invalidInput = await startFlow(pathToFileURL(path), null, { workspace: root, runtime });
    await expect(invalidInput.wait(10_000)).resolves.toMatchObject({ status: "failed", error: { code: "INVALID_INPUT" } });
    const invalidOutput = await startFlow(pathToFileURL(path), { valid: true }, { workspace: root, runtime });
    await expect(invalidOutput.wait(10_000)).resolves.toMatchObject({ status: "failed", error: { code: "INVALID_OUTPUT" } });

    const impossibleRoot = await workspace("impossible-error");
    const runId = randomUUID();
    const runDirectory = join(impossibleRoot, ".coding-flow", "runs", runId);
    await mkdir(join(runDirectory, "artifacts"), { recursive: true });
    const errorArtifact = await publishJson(runDirectory, join(runDirectory, "artifacts", "error.json"), {
      code: "CONTRACT_INVALID", message: "must not cross the public boundary",
    });
    const placeholder = { path: "missing", sha256: "0".repeat(64), bytes: 0, mediaType: "application/json" };
    const journal = new Journal(runDirectory, runId);
    await journal.append("run.created", {
      runId, entry: "file:///flow.ts", workspace: impossibleRoot, attempt: 1, runtime: { provider: "codex" },
      allowEdits: false, hostLimits: {}, inputArtifact: placeholder, bundleArtifact: placeholder,
      initializationCharges: { compilations: 1, inputValidations: 0 }, supervisorPid: process.pid,
    });
    await journal.append("run.failed", { errorArtifact } as unknown as import("../src/contracts.js").Json);
    await expect(openRun(impossibleRoot, runId).wait(100)).rejects.toThrow();
  });

  test("lists contained run directories deterministically", async () => {
    const root = await workspace("listing");
    const runs = join(root, ".coding-flow", "runs");
    await mkdir(runs, { recursive: true });
    await expect(listRuns(root)).resolves.toEqual([]);
  });
});
