import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { publishBytes, publishJson } from "../src/artifacts.js";
import { providerObservationSchema } from "../src/adapters/types.js";
import { canonicalJson, type Json } from "../src/contracts.js";
import { inspectRecovery, resumeRun, startFlow } from "../src/host.js";
import { HumanCoordinator } from "../src/human.js";
import { Journal, readVerifiedEvents } from "../src/journal.js";
import { ProcessService } from "../src/process.js";
import { materializeRecoveryRequest } from "../src/recovery.js";
import { captureInitialWorkspace, ReplayFrontier } from "../src/replay.js";
import { withTestControl } from "../src/testing.js";
import { dispatchProvider } from "../src/supervisor.js";

const fixture = new URL("./fixtures/process-child.mjs", import.meta.url).pathname;
const runner = new URL("../dist/src/runner.js", import.meta.url).pathname;
const runtime = { provider: "codex" as const };

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

async function stableHistory(workspace: string, runId: string) {
  while (true) {
    try { return await readVerifiedEvents(workspace, runId); }
    catch (error) {
      if (!(error instanceof Error && error.message === "File changed while reading")) throw error;
    }
  }
}

const artifact = { path: "artifacts/placeholder.json", sha256: "0".repeat(64), bytes: 0, mediaType: "application/json" };

test("native evidence terminal publication requires an immutable snapshot reference", () => {
  expect(() => providerObservationSchema.parse({
    provider: "codex", phase: "terminal", runId: randomUUID(), boundaryId: "agent-1", ordinal: 1,
    preparedHash: "0".repeat(64), attempt: 1, ownershipGeneration: 1, executableSha256: "0".repeat(64),
    configurationSha256: "0".repeat(64), executableVersion: "0.154.0", auth: "subscription",
    requestedModel: "fixture-model", outcome: "succeeded", actualModel: "fixture-model",
  })).toThrow();
});

test("native evidence publication failures leave an authorized attempt unresolved", async () => {
  for (const suffix of ["stdout.bin", "snapshot.json"]) {
    const state = await replayCrashFixture(`native-${suffix}`, true);
    const history = await readVerifiedEvents(state.root, state.runId);
    const journal = new Journal(state.runDirectory, state.runId, history);
    const frontier = await ReplayFrontier.open({ ...state, history, journal, limits: { maxCommands: 1, maxAgentCalls: 1 } });
    const service = new ProcessService();
    const request = { trace: ["root", 1], prompt: "fixture", schema: "text/v1", access: "read" } satisfies Json;
    const conflict = join(state.runDirectory, "artifacts", `provider-1-1-1-native-${suffix}`);
    await writeFile(conflict, "conflict");
    try {
      await expect(dispatchProvider({
        adapter: {
          async status() { return { provider: "codex", executable: process.execPath, version: "0.154.0", auth: "subscription", qualified: true }; },
          invocation() { return { executable: process.execPath, args: ["-e", "process.stdout.write('ok')"], cwd: state.root, stdin: "" }; },
          async capture(_request, returned, context) { return { version: 1, captureContext: context,
            status: { exitCode: returned.exitCode, signal: returned.signal, errorPresent: !!returned.error }, stdout: Buffer.from("synthetic") }; },
          async decode() { throw new Error("must not decode unpublished evidence"); },
        }, service, runDirectory: state.runDirectory, attemptId: "agent-1", signal: new AbortController().signal,
        request: { prompt: "fixture", access: "read", model: "fixture-model", workspace: state.root,
          operationDirectory: state.runDirectory, timeoutMs: 5_000 },
        observation: { workspace: state.root, runId: state.runId, journal, request, executable: process.execPath },
        perform: (dispatch, prepare, afterPrepared) => frontier.perform("agent", request, dispatch, () => true, prepare, afterPrepared),
        async prepare() {},
      })).rejects.toThrow("OUTCOME_UNKNOWN");
      const after = await readVerifiedEvents(state.root, state.runId);
      expect(after.filter(({ type }) => type === "dispatch.authorized")).toHaveLength(1);
      expect(after.filter(({ type }) => type === "provider.observed")).toHaveLength(1);
      expect(after.filter(({ type }) => type === "operation.committed")).toHaveLength(0);
    } finally { await service.dispose(); }
  }
}, 15_000);

async function replayCrashFixture(label: string, nativeProvider = false): Promise<{ root: string; runId: string; runDirectory: string; journal: Journal; baseline: string }> {
  const root = await mkdtemp(join(tmpdir(), `codeflow-${label}-`));
  await writeFile(join(root, "tracked.txt"), "base\n");
  const runId = randomUUID();
  const runDirectory = join(root, ".coding-flow/runs", runId);
  await mkdir(join(runDirectory, "artifacts"), { recursive: true });
  const journal = new Journal(runDirectory, runId);
  await journal.append("run.created", {
    runId, entry: "file:///fixture.ts", workspace: root, inputArtifact: artifact, bundleArtifact: artifact,
    initializationCharges: { compilations: 1, inputValidations: 0 }, supervisorPid: 1,
    ...(nativeProvider ? { runtime: { provider: "codex", executable: process.execPath, model: "fixture-model" } } : {}),
  });
  await journal.append("run.initialized", {
    inputArtifact: artifact, bundleArtifact: artifact, initializationCharges: { compilations: 1, inputValidations: 1 }, supervisorPid: 2,
  });
  await captureInitialWorkspace(runDirectory, journal, root, { maxCommands: 1, maxAgentCalls: 1 });
  const baseline = (JSON.parse(await readFile(join(runDirectory, "artifacts/workspace-initial.json"), "utf8")) as { sha256: string }).sha256;
  return { root, runId, runDirectory, journal, baseline };
}

function hashRequest(request: Json): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

describe("authorization ownership process group crash matrix", () => {
  test("provider process interruption before authority dispatches zero targets and resumes once", async () => {
    for (const phase of ["after-prepare", "after-invocation", "after-observation", "before-authorization"]) {
      const state = await replayCrashFixture(`provider-${phase}`, true);
      const script = join(state.runDirectory, "provider-crash.mjs");
      const module = (name: string) => new URL(`../dist/src/${name}.js`, import.meta.url).href;
      await writeFile(script, `
        import { createHash } from 'node:crypto';
        import { Journal, readVerifiedEvents } from ${JSON.stringify(module("journal"))};
        import { ReplayFrontier } from ${JSON.stringify(module("replay"))};
        import { ProcessService } from ${JSON.stringify(module("process"))};
        import { dispatchProvider } from ${JSON.stringify(module("supervisor"))};
        const state = ${JSON.stringify({ root: state.root, runDirectory: state.runDirectory, runId: state.runId })};
        const phase = process.argv[2];
        let history = await readVerifiedEvents(state.root, state.runId);
        const journal = new Journal(state.runDirectory, state.runId, history);
        if (phase === 'resume') { await journal.append('attempt.started', {attempt:2,cause:'resume'}); history=await readVerifiedEvents(state.root,state.runId); }
        const frontier = await ReplayFrontier.open({...state,journal,history,limits:{maxCommands:1,maxAgentCalls:1}});
        const service = new ProcessService();
        const request = {trace:['root',1],prompt:'fixture',schema:'text/v1',access:'read'};
        const adapter = {
          async status() { return {provider:'codex',executable:process.execPath,version:'0.154.0',auth:'subscription',qualified:true}; },
          invocation() { const invocation={executable:process.execPath,args:${JSON.stringify([fixture, "record", join(state.root, "effect")])},cwd:state.root,stdin:''};
            if (phase==='after-invocation') process.exit(91); return invocation; },
          async capture(request,returned,context) { const id='00000000-0000-4000-8000-000000000011'; const hash=s=>createHash('sha256').update(s).digest('hex');
            return {version:1,captureContext:context,status:{exitCode:returned.exitCode,signal:returned.signal,errorPresent:!!returned.error},
              stdout:Buffer.from(JSON.stringify({type:'thread.started',thread_id:id})+'\\n'+JSON.stringify({type:'turn.completed'})+'\\n'),
              finalOutput:Buffer.from('done'),codexSession:{sessionIdSha256:hash(id),source:'exec',cliVersion:'0.154.0',
                workspaceSha256:hash(request.workspace),promptSha256:hash(request.prompt),startedAt:context.startedAt,models:['fixture-model']}}; },
          async decode() { return {text:'done',actualModel:'fixture-model',sessionId:'00000000-0000-4000-8000-000000000011'}; }
        };
        try {
          const value = await dispatchProvider({adapter,service,runDirectory:state.runDirectory,attemptId:'agent-1',signal:new AbortController().signal,
            request:{prompt:'fixture',access:'read',model:'fixture-model',workspace:state.root,operationDirectory:state.runDirectory,timeoutMs:5000},
            observation:{workspace:state.root,runId:state.runId,journal,request,executable:process.execPath},async prepare(){},
            perform:(dispatch,prepare,afterPrepared)=>frontier.perform('agent',request,dispatch,()=>true,prepare,async binding=>{
              if(phase==='after-prepare')process.exit(91);
              await afterPrepared(binding);
              if(phase==='after-observation'||phase==='before-authorization')process.exit(91);
            })});
          if(value!=='done')process.exit(92);
        } finally { await service.dispose(); }
      `);
      const run = (at: string): Promise<number | null> => new Promise((done, reject) => {
        const child = fork(script, [at], { execArgv: [], stdio: "ignore" });
        child.once("error", reject); child.once("exit", done);
      });
      expect(await run(phase)).toBe(91);
      const interrupted = await readVerifiedEvents(state.root, state.runId);
      expect(interrupted.filter(({ type }) => type === "dispatch.authorized")).toHaveLength(0);
      await expect(readFile(join(state.root, "effect"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await run("resume")).toBe(0);
      expect(await readFile(join(state.root, "effect"), "utf8")).toBe("1");
      const final = await readVerifiedEvents(state.root, state.runId);
      expect(final.filter(({ type }) => type === "dispatch.authorized")).toHaveLength(1);
      expect(final.filter(({ type }) => type === "operation.committed")).toHaveLength(1);
    }
  }, 30_000);

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

describe("replay frontier limits freshness", () => {
  test("supervisor leaves a generic post-authorization failure unknown instead of terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeflow-supervisor-unknown-"));
    const entry = join(root, "unknown-flow.mjs");
    await writeFile(entry, `export default {
      kind: "coding-flow/v2",
      name: "unknown-after-authorization",
      description: "force registration failure after durable authorization",
      input: { parse: value => value },
      output: { parse: value => value },
      limits: { maxCommands: 1, timeoutMs: 0 },
      run: async context => context.command(process.execPath, ["--version"]),
    };\n`);
    const started = await startFlow(pathToFileURL(entry), {}, { workspace: root, runtime });
    const deadline = Date.now() + 5_000;
    let history = await stableHistory(root, started.runId);
    while (history.at(-1)?.type !== "dispatch.authorized" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      history = await stableHistory(root, started.runId);
    }
    expect(history.at(-1)?.type).toBe("dispatch.authorized");
    expect(history.some(({ type }) => type === "run.failed")).toBe(false);
  });

  test("a generic dispatch failure remains a journal-verifiable unknown outcome", async () => {
    const request = { trace: ["root", 1], schema: "review/v1", prompt: "transport-fails" } satisfies Json;
    const fixture = await replayCrashFixture("dispatch-failure");
    const history = await readVerifiedEvents(fixture.root, fixture.runId);
    const frontier = await ReplayFrontier.open({
      runDirectory: fixture.runDirectory,
      runId: fixture.runId,
      journal: new Journal(fixture.runDirectory, fixture.runId, history),
      history,
      limits: { maxCommands: 1, maxAgentCalls: 1 },
    });
    await expect(frontier.perform("agent", request, async () => {
      throw new Error("provider transport failed");
    })).rejects.toThrow("OUTCOME_UNKNOWN");
    const after = await readVerifiedEvents(fixture.root, fixture.runId);
    expect(after.at(-1)?.type).toBe("dispatch.authorized");
    expect(after.some(({ type }) => type === "run.failed")).toBe(false);
  });

  test("prepared crash first-dispatches while authorized crash blocks without redispatch", async () => {
    const request = { trace: ["root", 1], schema: "review/v1", prompt: "resume" } satisfies Json;
    const preparedFixture = await replayCrashFixture("prepared-crash");
    await preparedFixture.journal.append("operation.prepared", {
      ordinal: 1, scope: "root", kind: "agent", request, requestHash: hashRequest(request),
      preWorkspaceHash: preparedFixture.baseline, reservation: { commands: 0, agentCalls: 1 },
    });
    let dispatches = 0;
    const preparedHistory = await readVerifiedEvents(preparedFixture.root, preparedFixture.runId);
    const prepared = await ReplayFrontier.open({
      runDirectory: preparedFixture.runDirectory,
      runId: preparedFixture.runId,
      journal: new Journal(preparedFixture.runDirectory, preparedFixture.runId, preparedHistory),
      history: preparedHistory,
      limits: { maxCommands: 1, maxAgentCalls: 1 },
    });
    await prepared.perform("agent", request, async () => {
      dispatches += 1;
      return { verdict: "dispatched" };
    });

    const authorizedFixture = await replayCrashFixture("authorized-crash");
    const preparedEvent = await authorizedFixture.journal.append("operation.prepared", {
      ordinal: 1, scope: "root", kind: "agent", request, requestHash: hashRequest(request),
      preWorkspaceHash: authorizedFixture.baseline, reservation: { commands: 0, agentCalls: 1 },
    });
    await authorizedFixture.journal.append("dispatch.authorized", { preparedHash: preparedEvent.hash, ordinal: 1, kind: "agent" });
    const authorizedHistory = await readVerifiedEvents(authorizedFixture.root, authorizedFixture.runId);
    const authorized = await ReplayFrontier.open({
      runDirectory: authorizedFixture.runDirectory,
      runId: authorizedFixture.runId,
      journal: new Journal(authorizedFixture.runDirectory, authorizedFixture.runId, authorizedHistory),
      history: authorizedHistory,
      limits: { maxCommands: 1, maxAgentCalls: 1 },
    });
    await expect(authorized.perform("agent", request, async () => {
      dispatches += 1;
      return { verdict: "must-not-run" };
    })).rejects.toThrow("OUTCOME_UNKNOWN");
    expect(dispatches).toBe(1);
  });
});

describe("human approval recovery crash matrix", () => {
  async function humanCrashFixture(crashAt: "after-human-reply" | "after-approval-gate" | "after-author-delivery" | "after-approval-effect") {
    const sdk = fileURLToPath(new URL("../dist/src/sdk.js", import.meta.url));
    const root = await mkdtemp(join(tmpdir(), `codeflow-${crashAt}-`));
    const effect = join(root, "effect");
    const entry = join(root, "flow.ts");
    await writeFile(join(root, "tracked.txt"), "base\n");
    await writeFile(entry, `
      import { flow, z } from ${JSON.stringify(sdk)};
      export default flow({ name: "crash-approval", description: "Crash approval witness.",
        input: z.null(), output: z.number(), limits: { maxCommands: 1, humanTimeoutMs: 5000 },
        async run(context) {
          return context.human.approve({ title: "Apply", presentation: { title: "Evidence", markdown: "Apply once" },
            action: { effect: "once" }, watch: ["tracked.txt"] }, async () => {
            const result = await context.command(process.execPath, ${JSON.stringify([fixture, "record", effect])});
            return result.exitCode;
          });
        } });
    `);
    const started = await startFlow(pathToFileURL(entry), null, withTestControl(
      { workspace: root, runtime }, { crashAt },
    ));
    const waiting = await started.wait(10_000);
    expect(waiting.status).toBe("waiting-for-human");
    if (waiting.status !== "waiting-for-human") throw new Error("expected request");
    await started.respond({
      requestId: waiting.request.requestId, submissionId: `submission-${crashAt}`,
      revision: waiting.request.revision, presentationHash: waiting.request.presentationHash,
      answer: { decision: "approve", reason: "" },
    });
    return { root, effect, started };
  }

  async function resumeAfterCrash(root: string, runId: string) {
    let resumed: Awaited<ReturnType<typeof resumeRun>> | undefined;
    const deadline = Date.now() + 10_000;
    while (!resumed && Date.now() < deadline) {
      try { resumed = await resumeRun(root, runId); }
      catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 25)); }
    }
    if (!resumed) throw new Error("resume did not acquire ownership");
    return resumed;
  }

  async function waitForRecoveryRequest(handle: Awaited<ReturnType<typeof resumeRun>>) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const boundary = await handle.wait(250);
      if (boundary.status === "waiting-for-human" && boundary.request.kind === "recovery") return boundary;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    throw new Error("expected recovery request");
  }

  async function persistRecoveryDecision(
    root: string,
    runId: string,
    request: Extract<Awaited<ReturnType<typeof inspectRecovery>>, { status: "waiting-for-human" }>["request"],
    submissionId: string,
    answer: { readonly choice: "retry-no-application" | "abandon"; readonly reason: string; readonly evidencePaths: readonly string[] },
  ): Promise<void> {
    const runDirectory = join(root, ".coding-flow", "runs", runId);
    for (const [index, path] of answer.evidencePaths.entries()) {
      await publishBytes(
        runDirectory,
        join(runDirectory, "artifacts", "human", `recovery-${submissionId}-${String(index)}`),
        await readFile(join(root, path)),
        "application/octet-stream",
      );
    }
    const envelope = {
      requestId: request.requestId, submissionId, decision: "accept" as const, value: answer,
      userId: process.getuid?.() ?? 0,
    };
    const envelopeArtifact = await publishJson(
      runDirectory, join(runDirectory, "artifacts", "human", `reply-${submissionId}.json`), envelope,
    );
    const history = [...await readVerifiedEvents(root, runId)];
    await new Journal(runDirectory, runId, history).append("human.reply-decided", {
      requestId: request.requestId, submissionId,
      semanticHash: hashRequest({
        requestId: envelope.requestId, decision: envelope.decision, value: envelope.value, userId: envelope.userId,
      }),
      status: "accepted", value: answer, envelopeArtifact,
    } as unknown as Json);
  }

  test("human approval recovery preserves reply gate delivery and effect crash boundaries", async () => {
    for (const crashAt of ["after-human-reply", "after-approval-gate", "after-author-delivery", "after-approval-effect"] as const) {
      const { root, effect, started } = await humanCrashFixture(crashAt);
      if (crashAt === "after-approval-effect") {
        await expect(started.wait(250)).resolves.toMatchObject({ status: "blocked", reason: "OUTCOME_UNKNOWN" });
        const recovery = await inspectRecovery(root, started.runId);
        expect(recovery).toMatchObject({ status: "blocked", reason: "OUTCOME_UNKNOWN" });
        if (recovery.status !== "blocked" || !recovery.evidence[0]) throw new Error("expected recovery evidence");
        const resumed = await resumeAfterCrash(root, started.runId);
        const waitingRecovery = await resumed.wait(10_000);
        expect(waitingRecovery).toMatchObject({
          status: "waiting-for-human",
          request: { kind: "recovery", choices: ["retry-no-application", "abandon"] },
        });
        if (waitingRecovery.status !== "waiting-for-human") throw new Error("expected recovery request");
        await expect(started.respond({
          submissionId: "recovery-retry", requestId: waitingRecovery.request.requestId,
          revision: waitingRecovery.request.revision, presentationHash: waitingRecovery.request.presentationHash,
          answer: { choice: "retry-no-application", reason: "No application started", evidencePaths: ["tracked.txt"] },
        })).resolves.toMatchObject({ status: "accepted" });
        await expect(started.wait(10_000)).resolves.toMatchObject({ status: "succeeded", output: 0 });
        expect(await readFile(effect, "utf8")).toBe("1");
        const retried = await readVerifiedEvents(root, started.runId);
        const authorization = retried.find(({ type }) => type === "recovery.retry-authorized");
        expect(authorization).toBeDefined();
        const evidence = (authorization?.data as { evidence?: Array<{ path: string }> }).evidence?.[0];
        if (!evidence) throw new Error("missing submitted evidence snapshot");
        expect(await readFile(join(root, ".coding-flow/runs", started.runId, evidence.path), "utf8")).toBe("base\n");
      } else {
        const resumed = await resumeAfterCrash(root, started.runId);
        await expect(resumed.wait(10_000)).resolves.toMatchObject({ status: "succeeded", output: 0 });
        expect(await readFile(effect, "utf8")).toBe("1");
      }
    }
  }, 50_000);

  test("recovery completes a durably decided retry before treating its reply as applied", async () => {
    const { root, effect, started } = await humanCrashFixture("after-approval-effect");
    await expect(started.wait(250)).resolves.toMatchObject({ status: "blocked", reason: "OUTCOME_UNKNOWN" });
    const resumed = await resumeAfterCrash(root, started.runId);
    const waiting = await waitForRecoveryRequest(resumed);
    const answer = { choice: "retry-no-application" as const, reason: "No application started", evidencePaths: ["tracked.txt"] };
    await persistRecoveryDecision(root, started.runId, waiting.request, "recovery-gap-retry", answer);

    await expect(started.respond({
      submissionId: "recovery-gap-retry", requestId: waiting.request.requestId,
      revision: waiting.request.revision, presentationHash: waiting.request.presentationHash, answer,
    })).resolves.toMatchObject({ status: "already-applied" });
    expect((await readVerifiedEvents(root, started.runId)).filter(({ type }) => type === "recovery.retry-authorized")).toHaveLength(1);
    const continued = await resumeAfterCrash(root, started.runId);
    await expect(continued.wait(10_000)).resolves.toMatchObject({ status: "succeeded", output: 0 });
    expect(await readFile(effect, "utf8")).toBe("1");
  }, 20_000);

  test("recovery reply submission deduplicates an identical durable inbox file", async () => {
    const { root, started } = await humanCrashFixture("after-approval-effect");
    const resumed = await resumeAfterCrash(root, started.runId);
    const waiting = await waitForRecoveryRequest(resumed);
    const reply = {
      submissionId: "recovery-inbox-retry", requestId: waiting.request.requestId,
      revision: waiting.request.revision, presentationHash: waiting.request.presentationHash,
      answer: { choice: "retry-no-application", reason: "No application started", evidencePaths: ["tracked.txt"] },
    } as const;
    const inbox = join(root, ".coding-flow", "runs", started.runId, "recovery-inbox");
    await mkdir(inbox, { recursive: true });
    const path = join(inbox, `${reply.submissionId}.json`);
    await writeFile(path, `${JSON.stringify({ reply: { ...reply, answer: { choice: "abandon", reason: "different", evidencePaths: [] } } })}\n`);
    await expect(started.respond(reply)).rejects.toThrow("HUMAN_SUBMISSION_CONFLICT");
    await writeFile(path, `${JSON.stringify({ reply })}\n`);

    await expect(started.respond(reply)).resolves.toMatchObject({ status: "accepted" });
  }, 20_000);

  test("a later unknown effect receives distinct committed recovery authority", async () => {
    const { root, started } = await humanCrashFixture("after-approval-effect");
    const resumed = await resumeAfterCrash(root, started.runId);
    const first = await waitForRecoveryRequest(resumed);
    if (first.request.kind !== "recovery") throw new Error("expected recovery request");
    const submissionId = "first-recovery-boundary";
    const answer = { choice: "retry-no-application" as const, reason: "No application started", evidencePaths: ["tracked.txt"] };
    await persistRecoveryDecision(root, started.runId, first.request, submissionId, answer);
    const runDirectory = join(root, ".coding-flow", "runs", started.runId);
    const retainedBytes = await readFile(join(runDirectory, "artifacts", "human", `recovery-${submissionId}-0`));
    const retained = {
      path: `artifacts/human/recovery-${submissionId}-0`,
      sha256: createHash("sha256").update(retainedBytes).digest("hex"), bytes: retainedBytes.length,
      mediaType: "application/octet-stream",
    };
    const history = [...await readVerifiedEvents(root, started.runId)];
    const journal = new Journal(runDirectory, started.runId, history);
    history.push(await journal.append("recovery.retry-authorized", {
      requestId: first.request.requestId, boundaryId: first.request.boundaryId, evidence: [retained],
    } as unknown as Json));

    const human = await HumanCoordinator.open({ runDirectory, workspace: root, runId: started.runId, journal, history });
    const trace = ["root", "later-approval"];
    const presentation = await human.perform({
      kind: "present", trace, presentation: { title: "Later effect", markdown: "A distinct boundary" },
    });
    const operation = {
      kind: "approve" as const, trace, presentation,
      title: "Later effect", action: { effect: "later" }, watch: [], timeoutMs: 5_000,
    };
    const requestId = hashRequest({
      runId: started.runId,
      request: { kind: operation.kind, trace, presentation, title: operation.title, action: operation.action, watch: operation.watch },
    });
    await writeFile(join(runDirectory, "inbox", "later-approval.json"), JSON.stringify({
      requestId, submissionId: "later-approval", decision: "accept", value: "approved", userId: process.getuid?.() ?? 0,
    }));
    await human.perform(operation);
    await human.authorizeEffect(requestId, { effect: "later" });
    const laterHistory = [...human.history()];
    await materializeRecoveryRequest({
      runDirectory, workspace: root, runId: started.runId, journal, history: laterHistory,
      state: {
        status: "blocked", reason: "OUTCOME_UNKNOWN", message: "The later effect outcome is unknown.",
        choices: ["retry-no-application", "abandon"], evidence: [],
      },
      attempt: first.request.attempt + 1,
    });

    const requests = laterHistory.filter(({ type }) => type === "human.requested");
    expect(requests).toHaveLength(4);
    const latest = await inspectRecovery(root, started.runId);
    expect(latest).toMatchObject({
      status: "waiting-for-human",
      request: { kind: "recovery", attempt: first.request.attempt + 1 },
    });
    if (latest.status !== "waiting-for-human" || latest.request.kind !== "recovery") throw new Error("expected later recovery request");
    expect(latest.request.requestId).not.toBe(first.request.requestId);
    expect(latest.request.boundaryId).not.toBe(first.request.boundaryId);
  }, 20_000);

  test("recovery staging reuses an immutable artifact left before its journal event", async () => {
    const { root, started } = await humanCrashFixture("after-approval-effect");
    await expect(started.wait(250)).resolves.toMatchObject({ status: "blocked", reason: "OUTCOME_UNKNOWN" });
    const blocked = await inspectRecovery(root, started.runId);
    if (blocked.status !== "blocked") throw new Error("expected unknown outcome");
    const runDirectory = join(root, ".coding-flow", "runs", started.runId);
    const history = [...await readVerifiedEvents(root, started.runId)];
    const boundary = [...history].reverse().find(({ type }) => type === "approval.effect-authorized");
    if (!boundary) throw new Error("missing effect boundary");
    const boundaryId = String((boundary.data as { readonly requestId: Json }).requestId);
    const presentation = {
      title: "Recovery required",
      markdown: `${blocked.message}\n\nBoundary ${boundaryId}, attempt 2. The old outcome remains unknown. Restoring local files does not prove that remote effects did not occur.`,
    };
    const presentationHash = hashRequest(presentation);
    const journal = new Journal(runDirectory, started.runId, history);
    const options = {
      runDirectory, workspace: root, runId: started.runId,
      journal, history,
      state: {
        status: "blocked", reason: "OUTCOME_UNKNOWN", message: blocked.message,
        choices: ["retry-no-application", "abandon"] as const, evidence: blocked.evidence,
      },
      attempt: 2,
    } as const;
    for (const stage of ["presentation", "workspace", "request"] as const) {
      await expect(materializeRecoveryRequest({
        ...options,
        afterArtifact(actual) { if (actual === stage) throw new Error(`crash-after-${stage}`); },
      })).rejects.toThrow(`crash-after-${stage}`);
    }
    const presentationPath = join(runDirectory, "artifacts", "human", `recovery-presentation-${presentationHash}.json`);
    const presentationBytes = await readFile(presentationPath);
    await writeFile(presentationPath, "conflict\n");
    await expect(materializeRecoveryRequest(options)).rejects.toThrow("EVIDENCE_CORRUPT");
    await writeFile(presentationPath, presentationBytes);
    await expect(materializeRecoveryRequest(options)).resolves.toBeUndefined();
    expect(history.filter(({ type }) => type === "presentation.published")).toHaveLength(2);
    expect(history.filter(({ type }) => type === "human.requested")).toHaveLength(2);
  }, 20_000);

  test("resume completes a durably decided recovery abandonment", async () => {
    const { root, started } = await humanCrashFixture("after-approval-effect");
    await expect(started.wait(250)).resolves.toMatchObject({ status: "blocked", reason: "OUTCOME_UNKNOWN" });
    const resumed = await resumeAfterCrash(root, started.runId);
    const waiting = await waitForRecoveryRequest(resumed);
    await persistRecoveryDecision(root, started.runId, waiting.request, "recovery-gap-abandon", {
      choice: "abandon", reason: "Stop safely", evidencePaths: [],
    });

    await expect(resumeRun(root, started.runId)).rejects.toThrow("Run is not resumable");
    await expect(started.wait(10_000)).resolves.toMatchObject({ status: "cancelled" });
    expect((await readVerifiedEvents(root, started.runId)).filter(({ type }) => type === "run.cancelled")).toHaveLength(1);
  }, 20_000);

  test("human approval recovery does not expose a live owned effect as blocked", async () => {
    const sdk = fileURLToPath(new URL("../dist/src/sdk.js", import.meta.url));
    const root = await mkdtemp(join(tmpdir(), "codeflow-live-approval-"));
    const entry = join(root, "flow.ts");
    await writeFile(join(root, "tracked.txt"), "base\n");
    await writeFile(entry, `
      import { flow, z } from ${JSON.stringify(sdk)};
      export default flow({ name: "live-approval", description: "Live approval witness.",
        input: z.null(), output: z.number(), limits: { maxCommands: 1, humanTimeoutMs: 5000 },
        async run(context) {
          return context.human.approve({ title: "Apply", presentation: { title: "Evidence", markdown: "Apply once" },
            action: { effect: "once" }, watch: ["tracked.txt"] }, async () => {
            const result = await context.command(process.execPath, ["-e", "setTimeout(() => {}, 2000)"]);
            return result.exitCode;
          });
        } });
    `);
    const started = await startFlow(pathToFileURL(entry), null, { workspace: root, runtime });
    const boundary = await started.wait(10_000);
    if (boundary.status !== "waiting-for-human") throw new Error("expected request");
    const submission = {
      requestId: boundary.request.requestId, submissionId: "submission-live",
      revision: boundary.request.revision, presentationHash: boundary.request.presentationHash,
      answer: { decision: "approve", reason: "" },
    } as const;
    const journalPath = join(root, ".coding-flow/runs", started.runId, "events.jsonl");
    let touchingReply = true;
    const touchReplyJournal = (async () => {
      let offset = 1;
      while (touchingReply) {
        const changed = new Date(Date.now() + offset * 1_000);
        await utimes(journalPath, changed, changed);
        offset += 1;
      }
    })();
    let responseSettled = false;
    const responding = started.respond(submission).finally(() => { responseSettled = true; });
    const responseExpectation = expect(responding).resolves.toMatchObject({ status: "accepted" });
    try {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      expect(responseSettled).toBe(false);
    } finally {
      touchingReply = false;
      await touchReplyJournal;
    }
    await responseExpectation;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const history = await readVerifiedEvents(root, started.runId);
      if (history.some(({ type }) => type === "approval.effect-authorized")) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    expect((await readVerifiedEvents(root, started.runId)).some(({ type }) => type === "approval.effect-authorized")).toBe(true);
    let touching = true;
    const touchJournal = (async () => {
      let offset = 1;
      while (touching) {
        const changed = new Date(Date.now() + offset * 1_000);
        await utimes(journalPath, changed, changed);
        offset += 1;
      }
    })();
    let inspections;
    try {
      inspections = await Promise.allSettled(Array.from({ length: 64 }, () => inspectRecovery(root, started.runId)));
    } finally {
      touching = false;
      await touchJournal;
    }
    expect(inspections.every((inspection) => inspection.status === "rejected"
      || inspection.value.status === "running")).toBe(true);
    await expect(started.wait(10_000)).resolves.toMatchObject({ status: "succeeded", output: 0 });
    await writeFile(journalPath, (await readFile(journalPath, "utf8")).replace('"run.created"', '"run.invalid"'));
    await expect(started.respond(submission)).rejects.toThrow("Corrupt journal");
  }, 15_000);

  test("human approval recovery rechecks freshness immediately before effect authority", async () => {
    const { root, effect, started } = await humanCrashFixture("after-author-delivery");
    await writeFile(join(root, "tracked.txt"), "changed after delivery\n");
    const resumed = await resumeAfterCrash(root, started.runId);
    await expect(resumed.wait(500)).resolves.toMatchObject({
      status: "failed", error: { message: "WORKSPACE_CHANGED" },
    });
    const history = await readVerifiedEvents(root, started.runId);
    expect(history.some(({ type }) => type === "approval.effect-authorized")).toBe(false);
    await expect(readFile(effect)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);
});
