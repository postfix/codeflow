import { ChildProcess, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson, type Json } from "../src/contracts.js";
import { assertFoundationTarget, classifyDarwinProcessGroup, liveAcceptanceSubject, matchesDarwinGroupMemberIdentity, matchesDarwinProcessIdentity, runFoundationPhase, runLiveAcceptanceVerification, type FoundationEvidence, type FoundationOptions } from "../src/testing.js";
import { readVerifiedEvents } from "../src/journal.js";
import { startFlow, resumeRun } from "../src/host.js";
import { probeProcessGroup } from "../src/process.js";

const localTarget = process.platform === "darwin" ? "macos-github" : "linux-local";
const mismatchedTarget = localTarget === "linux-local" ? "macos-github" : "linux-local";

function forgeEvidence(evidence: FoundationEvidence, changes: Partial<FoundationEvidence>): FoundationEvidence {
  const { evidenceHash: _, ...current } = evidence;
  const unsigned = { ...current, ...changes };
  return {
    ...unsigned,
    evidenceHash: createHash("sha256").update(canonicalJson(unsigned as unknown as Json)).digest("hex"),
  };
}

function groupAlive(groupId: number): boolean {
  const state = probeProcessGroup(groupId);
  if (state === "unknown") throw new Error("Group presence could not be established");
  return state === "present";
}

function processAlive(processId: number): boolean {
  try { process.kill(processId, 0); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessAbsent(processId: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (processAlive(processId) && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
}

async function stopGroup(groupId: number): Promise<void> {
  try { process.kill(-groupId, "SIGKILL"); } catch {}
  const deadline = Date.now() + 5_000;
  while (groupAlive(groupId) && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
}

function cliOptions(): FoundationOptions | undefined {
  const target = option("target");
  const requestedPhase = option("phase");
  const phase = requestedPhase === "recover" ? "resume" : requestedPhase;
  const scenario = option("scenario");
  const evidence = option("evidence");
  if (!target && !phase && !scenario && !evidence) return undefined;
  if (!(["linux-local", "macos-github"] as const).includes(target as never)
    || !(["prepare", "interrupt", "resume", "verify"] as const).includes(phase as never)
    || !(["process-interrupt", "reboot"] as const).includes(scenario as never)
    || !evidence) throw new Error("Usage: --target TARGET --phase PHASE --scenario SCENARIO --evidence PATH");
  return { target, phase, scenario, evidence } as FoundationOptions;
}

const live = process.argv.includes("--host-acceptance");
const cli = live ? undefined : cliOptions();
if (live) {
  const target = option("target");
  const provider = option("provider");
  const workspace = option("workspace");
  const manifest = option("manifest");
  const result = option("result");
  if (target !== "linux-local" || (provider !== "codex" && provider !== "claude") || !workspace || !manifest || !result) {
    throw new Error("Usage: --target linux-local --provider codex|claude --workspace PATH --manifest PATH --result PATH");
  }
  process.stdout.write(`${JSON.stringify(await runLiveAcceptanceVerification({ target, provider, workspace, manifest, result }))}\n`);
} else if (cli) {
  const evidence = await runFoundationPhase(cli);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    target: evidence.target,
    scenario: evidence.scenario,
    status: evidence.status,
    identity: evidence.identity,
    stableLockExclusion: evidence.stableLockExclusion,
    processGroup: evidence.processGroup,
    counters: evidence.counters,
    evidenceHash: evidence.evidenceHash,
  })}\n`);
} else {
  const { describe, expect, test, vi } = await import("vitest");

  describe("live acceptance verification", () => {
    test("foundation CLI accepts recover as the resume phase", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      try {
        const entry = fileURLToPath(new URL("../dist/tests/qualification.test.js", import.meta.url));
        for (const phase of ["resume", "recover"]) {
          const result = spawnSync(process.execPath, [entry, "--target", localTarget, "--phase", phase,
            "--scenario", "process-interrupt", "--evidence", join(root, "missing.json")], { encoding: "utf8" });
          expect(result.status).toBe(1);
          expect(result.stderr).toContain("INVALID_QUALIFICATION_EVIDENCE");
        }
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    test("native evidence fixture subject includes the corrected native format files", async () => {
      const repository = await mkdtemp(join(tmpdir(), "codeflow-native-subject-"));
      const paths = ["tests/fixtures/host-flow.ts", "tests/fixtures/codex.jsonl", "tests/fixtures/claude.json", "tests/adapters.test.ts",
        "src/adapters/types.ts", "src/adapters/codex.ts", "src/adapters/claude.ts", "src/testing.ts",
        "tests/fixtures/codex-session.json", "tests/fixtures/claude.jsonl"];
      try {
        for (const path of paths) {
          await mkdir(join(repository, path.split("/").slice(0, -1).join("/")), { recursive: true });
          await writeFile(join(repository, path), path);
        }
        const first = await liveAcceptanceSubject(repository);
        await writeFile(join(repository, "tests/fixtures/codex-session.json"), "changed");
        expect((await liveAcceptanceSubject(repository)).fixtureSetSha256).not.toBe(first.fixtureSetSha256);
      } finally { await rm(repository, { recursive: true, force: true }); }
    });
    test("rejects missing and ambiguous manifests without publishing a result", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "codeflow-live-invalid-"));
      try {
        await mkdir(join(workspace, ".coding-flow-qualification"));
        const options = { target: "linux-local" as const, provider: "claude" as const, workspace,
          manifest: ".coding-flow-qualification/input.json", result: ".coding-flow-qualification/result.json" };
        await expect(runLiveAcceptanceVerification(options)).rejects.toThrow();
        await writeFile(join(workspace, options.manifest), JSON.stringify({ version: 1, target: "linux-local", provider: "claude", forged: true }));
        await expect(runLiveAcceptanceVerification(options)).rejects.toThrow();
        await expect(readFile(join(workspace, options.result))).rejects.toMatchObject({ code: "ENOENT" });
      } finally { await rm(workspace, { recursive: true, force: true }); }
    });

    test("verifies fixture consent recovery cancellation and refuses result collisions", async () => {
      if (process.platform !== "linux") return;
      const verify = (await import(new URL("../dist/src/testing.js", import.meta.url).href) as {
        runLiveAcceptanceVerification: typeof runLiveAcceptanceVerification;
      }).runLiveAcceptanceVerification;
      const workspace = await mkdtemp(join(tmpdir(), "codeflow-live-valid-"));
      try {
        const entry = join(workspace, "host-flow.ts");
        const source = await readFile(new URL("./fixtures/host-flow.ts", import.meta.url), "utf8");
        const sdk = fileURLToPath(new URL("../dist/src/sdk.js", import.meta.url));
        await writeFile(entry, source.replace("../../src/sdk.js", sdk));
        const executable = join(workspace, "fixture-claude.mjs");
        await writeFile(executable, `#!${process.execPath}\n
          if (process.argv.includes('--version')) console.log('2.1.274 (Claude Code)');
          else if (process.argv.includes('status')) console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'}));
          else { let prompt=''; for await (const chunk of process.stdin) prompt+=chunk;
            if (!prompt.includes('{')) throw new Error('fixture stdin: '+JSON.stringify(prompt));
            console.log(JSON.stringify({type:'system',subtype:'init',model:'fixture-model',session_id:'fixture-session'}));
            console.log(JSON.stringify({type:'assistant',session_id:'fixture-session',parent_tool_use_id:null,message:{model:'fixture-model',content:[{type:'text',text:'synthetic fixture'}]}}));
            console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,permission_denials:[],session_id:'fixture-session',structured_output:JSON.parse(prompt.slice(prompt.indexOf('{')))})); }
        `, { mode: 0o700 });
        const runtime = { provider: "claude" as const, executable, model: "fixture-model" };
        const complete = async (recover: boolean) => {
          let handle = await startFlow(pathToFileURL(entry), { message: "acceptance", delayMs: 0, acceptance: true }, { workspace, runtime });
          const first = await handle.wait(15_000);
          if (first.status === "blocked") {
            const returned = await readFile(join(workspace, ".coding-flow/runs", handle.runId, "operations/agent-1.committed.json"), "utf8");
            const claim = await readFile(join(workspace, ".coding-flow/runs", handle.runId, "operations/agent-1.claim.json"), "utf8");
            throw new Error(`fixture provider blocked: ${returned}; claim: ${claim}`);
          }
          expect(first.status, JSON.stringify(first)).toBe("waiting-for-human");
          if (first.status !== "waiting-for-human") throw new Error("missing first approval");
          const before = (await readVerifiedEvents(workspace, handle.runId)).at(-1)!;
          const respond = async (boundary: typeof first, submissionId: string, answer: Json) => handle.respond({ requestId: boundary.request.requestId,
            revision: boundary.request.revision, presentationHash: boundary.request.presentationHash, submissionId, answer });
          await respond(first, "first-denial", { decision: "reject", reason: "fixture denial" });
          const second = await handle.wait(5_000);
          if (second.status !== "waiting-for-human") throw new Error(`missing revision: ${JSON.stringify(second)}`);
          await respond(second, "revision-approval", { decision: "approve", reason: "fixture approval" });
          let checkpoint = await handle.wait(10_000);
          if (checkpoint.status !== "waiting-for-human") throw new Error(`missing checkpoint: ${JSON.stringify(checkpoint)}`);
          if (recover) {
            const history = await readVerifiedEvents(workspace, handle.runId);
            process.kill(Number((history[0]!.data as Record<string, Json>).supervisorPid), "SIGKILL");
            await new Promise((done) => setTimeout(done, 100));
            handle = await resumeRun(workspace, handle.runId);
            checkpoint = await handle.wait(10_000);
            if (checkpoint.status !== "waiting-for-human") throw new Error(`recovery checkpoint: ${JSON.stringify(checkpoint)}`);
          }
          await respond(checkpoint, "checkpoint", "continue");
          expect(await handle.wait(10_000)).toMatchObject({ status: "succeeded" });
          const after = (await readVerifiedEvents(workspace, handle.runId)).at(-1)!;
          return { runId: handle.runId, before: `${handle.runId}:${before.sequence}:${before.hash}`, after: `${handle.runId}:${after.sequence}:${after.hash}` };
        };
        const happy = await complete(false);
        const recovery = await complete(true);
        const cancelled = await startFlow(pathToFileURL(entry), { message: "acceptance", delayMs: 60_000, acceptance: true }, { workspace, runtime });
        await cancelled.cancel("fixture cancellation");
        expect(await cancelled.wait(10_000)).toMatchObject({ status: "cancelled" });
        await mkdir(join(workspace, ".coding-flow-qualification"));
        const manifest = { version: 1, target: "linux-local", provider: "claude", ...await liveAcceptanceSubject(),
          runs: { happyPath: happy.runId, interruptedRecovery: recovery.runId, cancellation: cancelled.runId },
          hostSteps: { provenance: "operator-asserted", firstInvocationReceipt: happy.before, reconnectedInvocationReceipt: happy.after, contextClosedAndReopened: true } };
        const options = { target: "linux-local" as const, provider: "claude" as const, workspace,
          manifest: ".coding-flow-qualification/input.json", result: ".coding-flow-qualification/result.json" };
        await writeFile(join(workspace, options.manifest), JSON.stringify(manifest));
        expect(await verify(options)).toMatchObject({ human: { rejectionEffects: 0, approvalEffects: 1 }, recovery: { committedRedispatches: 0 } });
        await expect(verify(options)).rejects.toMatchObject({ code: "EEXIST" });
        const happyDirectory = join(workspace, ".coding-flow/runs", happy.runId);
        const happyHistory = await readVerifiedEvents(workspace, happy.runId);
        const terminalObservation = happyHistory.filter(({ type }) => type === "provider.observed").at(-1)!;
        const observationRef = (terminalObservation.data as { observationArtifact: { path: string } }).observationArtifact;
        const observation = JSON.parse(await readFile(join(happyDirectory, observationRef.path), "utf8")) as {
          nativeEvidenceArtifact: { path: string };
        };
        const snapshotPath = join(happyDirectory, observation.nativeEvidenceArtifact.path);
        const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as { stdoutArtifact: { path: string } };
        const stdoutPath = join(happyDirectory, snapshot.stdoutArtifact.path);
        for (const path of [snapshotPath, stdoutPath]) {
          const bytes = await readFile(path);
          await writeFile(path, Buffer.from("corrupted native evidence"));
          const result = `.coding-flow-qualification/corrupt-${path === snapshotPath ? "snapshot" : "stdout"}.json`;
          await expect(verify({ ...options, result })).rejects.toThrow();
          await expect(readFile(join(workspace, result))).rejects.toMatchObject({ code: "ENOENT" });
          await writeFile(path, bytes);
          await rm(path);
          const missing = `.coding-flow-qualification/missing-${path === snapshotPath ? "snapshot" : "stdout"}.json`;
          await expect(verify({ ...options, result: missing })).rejects.toThrow();
          await expect(readFile(join(workspace, missing))).rejects.toMatchObject({ code: "ENOENT" });
          await writeFile(path, bytes);
        }
        const processPath = join(happyDirectory, "operations/agent-1.committed.json");
        const processBytes = await readFile(processPath);
        const processRecord = JSON.parse(processBytes.toString("utf8")) as Record<string, unknown>;
        for (const [field, value] of [["exitCode", 1], ["signal", "SIGTERM"], ["error", "tampered"]] as const) {
          await writeFile(processPath, JSON.stringify({ ...processRecord, [field]: value }));
          const result = `.coding-flow-qualification/status-${field}.json`;
          await expect(verify({ ...options, result })).rejects.toThrow();
          await expect(readFile(join(workspace, result))).rejects.toMatchObject({ code: "ENOENT" });
          await writeFile(processPath, processBytes);
        }
        await writeFile(join(workspace, options.manifest), JSON.stringify({ ...manifest, runs: { ...manifest.runs, interruptedRecovery: happy.runId } }));
        await expect(verify({ ...options, result: ".coding-flow-qualification/invalid.json" })).rejects.toThrow("LIVE_MANIFEST_MISMATCH");
        await expect(readFile(join(workspace, ".coding-flow-qualification/invalid.json"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally { await rm(workspace, { recursive: true, force: true }); }
    }, 60_000);
  });

  describe("foundation qualification", () => {
    test("runtime classes treat WSL2 as Linux and reserve reboot evidence for Linux", async () => {
      const linux = {
        platform: "linux",
        release: "5.15.153.1-microsoft-standard-WSL2",
        filesystem: { type: "0xef53", blockSize: 4_096, device: "1", format: "ext4" },
      };
      const macos = {
        platform: "darwin",
        release: "24.6.0",
        filesystem: { type: "0x1a", blockSize: 4_096, device: "1", format: "statfs-1a" },
      };

      expect(() => assertFoundationTarget("linux-local", linux, "process-interrupt")).not.toThrow();
      expect(() => assertFoundationTarget("linux-local", {
        ...linux,
        filesystem: { ...linux.filesystem, format: "fuse.sshfs" },
      }, "process-interrupt")).toThrow("FILESYSTEM_NOT_LOCAL");
      expect(() => assertFoundationTarget("wsl2-linux-fs", linux, "process-interrupt")).toThrow("TARGET_MISMATCH");
      expect(() => assertFoundationTarget("macos-github", macos, "process-interrupt")).not.toThrow();
      expect(() => assertFoundationTarget("macos-github", macos, "reboot"))
        .toThrow("GitHub-hosted jobs cannot provide a physical-reboot witness");
      await expect(runFoundationPhase({
        target: "macos-github",
        phase: "prepare",
        scenario: "reboot",
        evidence: ".coding-flow-qualification/rejected-macos-reboot.json",
      })).rejects.toThrow("GitHub-hosted jobs cannot provide a physical-reboot witness");
    });

    test("process interruption recovers synchronized evidence without resetting counters", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const refs = vi.spyOn(ChildProcess.prototype, "ref");
      const unrefs = vi.spyOn(ChildProcess.prototype, "unref");
      let prepared: Awaited<ReturnType<typeof runFoundationPhase>> | undefined;
      try {
        prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence });
        const leader = (unrefs.mock.contexts as ChildProcess[]).find((child) => child.pid === prepared!.processGroup!.groupId);
        expect(leader).toBeDefined();
        const interrupted = await runFoundationPhase({ target: localTarget, phase: "interrupt", scenario: "process-interrupt", evidence });
        expect(interrupted.processGroup?.cleanup).toBe("absent");
        expect(refs.mock.contexts as ChildProcess[]).toContain(leader);
        expect(leader!.exitCode ?? leader!.signalCode).not.toBeNull();
        await expect(runFoundationPhase({ target: localTarget, phase: "resume", scenario: "process-interrupt", evidence }))
          .resolves.toMatchObject({ status: "resumed", counters: { prepare: 1, interrupt: 1, resume: 1, verify: 0 } });
        await expect(runFoundationPhase({ target: localTarget, phase: "verify", scenario: "process-interrupt", evidence }))
          .resolves.toMatchObject({ status: "passed", counters: { prepare: 1, interrupt: 1, resume: 1, verify: 1 } });
      } finally {
        refs.mockRestore();
        unrefs.mockRestore();
        if (prepared?.processGroup) try { process.kill(-prepared.processGroup.groupId, "SIGKILL"); } catch {}
        await rm(root, { recursive: true, force: true });
      }
    }, 20_000);

    test("late qualification child exit releases its retained handle", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence });
      const groupId = prepared.processGroup!.groupId;
      const nonce = prepared.processGroup!.nonce;
      const kill = process.kill.bind(process);
      const deletes = vi.spyOn(Map.prototype, "delete");
      let delayed = false;
      const signals = vi.spyOn(process, "kill").mockImplementation(((processId: number, signal?: NodeJS.Signals | number) => {
        if (processId === -groupId && signal === "SIGKILL" && !delayed) {
          delayed = true;
          setTimeout(() => { try { kill(processId, signal); } catch {} }, 5_100);
          return true;
        }
        return kill(processId, signal);
      }) as typeof process.kill);
      try {
        await expect(runFoundationPhase({ target: localTarget, phase: "interrupt", scenario: "process-interrupt", evidence }))
          .resolves.toMatchObject({ processGroup: { cleanup: "absent" } });
        expect(deletes.mock.calls.some(([key]) => key === nonce)).toBe(true);
      } finally {
        signals.mockRestore();
        deletes.mockRestore();
        await stopGroup(groupId);
        await rm(root, { recursive: true, force: true });
      }
    }, 20_000);

    test("unknown ownership never permits fallback hard-kill cleanup", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const unrefs = vi.spyOn(ChildProcess.prototype, "unref");
      const deletes = vi.spyOn(Map.prototype, "delete");
      const prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence });
      const leader = (unrefs.mock.contexts as ChildProcess[]).find((child) => child.pid === prepared.processGroup!.groupId)!;
      const signals = vi.spyOn(process, "kill");
      process.env.CODEFLOW_TEST_QUALIFICATION_GROUP_STATE = "unknown";
      try {
        await expect(runFoundationPhase({ target: localTarget, phase: "interrupt", scenario: "process-interrupt", evidence }))
          .rejects.toThrow("PROCESS_GROUP_ABSENCE_UNPROVED");
        expect(signals.mock.calls.some(([groupId, signal]) => groupId === -prepared.processGroup!.groupId && signal === "SIGKILL"))
          .toBe(false);
        delete process.env.CODEFLOW_TEST_QUALIFICATION_GROUP_STATE;
        try { process.kill(-prepared.processGroup!.groupId, "SIGKILL"); } catch {}
        if (leader.exitCode === null && leader.signalCode === null) await new Promise<void>((resolveExit) => leader.once("exit", () => resolveExit()));
        expect(deletes.mock.calls.some(([key]) => key === prepared.processGroup!.nonce)).toBe(true);
      } finally {
        delete process.env.CODEFLOW_TEST_QUALIFICATION_GROUP_STATE;
        signals.mockRestore();
        deletes.mockRestore();
        unrefs.mockRestore();
        try { process.kill(-prepared.processGroup!.groupId, "SIGKILL"); } catch {}
        await rm(root, { recursive: true, force: true });
      }
    });

    test("an incomplete readiness marker cannot become ready or orphan its group", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      process.env.CODEFLOW_TEST_QUALIFICATION_MARKER = "incomplete";
      try {
        await expect(runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence }))
          .rejects.toThrow(/JSON/);
        const paths = await readdir(root, { recursive: true });
        const pidPath = paths.find((path) => path.endsWith("qualification-group.json.pid"));
        expect(pidPath).toBeDefined();
        const groupId = Number(await readFile(join(root, pidPath!), "utf8"));
        expect(groupAlive(groupId)).toBe(false);
        await expect(readFile(evidence)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        delete process.env.CODEFLOW_TEST_QUALIFICATION_MARKER;
        await rm(root, { recursive: true, force: true });
      }
    });

    test("concurrent prepare has one winner and creates no losing process group", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const groups: number[] = [];
      try {
        const outcomes = await Promise.allSettled([
          runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence }),
          runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence }),
        ]);
        const winners = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
        groups.push(...winners.flatMap((winner) => winner.processGroup ? [winner.processGroup.groupId] : []));
        expect(winners).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
        expect(await readdir(join(root, "workspaces"))).toHaveLength(1);
      } finally {
        await Promise.all(groups.map(stopGroup));
        await rm(root, { recursive: true, force: true });
      }
    });

    test("mismatched and corrupt evidence cannot advance", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence });
      try {
        const before = await readFile(evidence, "utf8");
        await expect(runFoundationPhase({ target: mismatchedTarget, phase: "interrupt", scenario: "process-interrupt", evidence }))
          .rejects.toThrow("QUALIFICATION_IDENTITY_MISMATCH");
        expect(await readFile(evidence, "utf8")).toBe(before);
        const parsed = JSON.parse(before);
        parsed.counters.prepare = 2;
        await writeFile(evidence, JSON.stringify(parsed));
        await expect(runFoundationPhase({ target: localTarget, phase: "interrupt", scenario: "process-interrupt", evidence }))
          .rejects.toThrow("INVALID_QUALIFICATION_EVIDENCE");
      } finally {
        if (prepared.processGroup) try { process.kill(-prepared.processGroup.groupId, "SIGKILL"); } catch {}
        await rm(root, { recursive: true, force: true });
      }
    });

    test("reboot evidence cannot resume during the preparing boot", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "reboot.json"));
      try {
        if (localTarget === "macos-github") {
          await expect(runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "reboot", evidence }))
            .rejects.toThrow("GitHub-hosted jobs cannot provide a physical-reboot witness");
          return;
        }
        await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "reboot", evidence });
        await expect(runFoundationPhase({ target: localTarget, phase: "resume", scenario: "reboot", evidence }))
          .rejects.toThrow("REBOOT_NOT_OBSERVED");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("stale but correctly signed evidence cannot advance", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const preparedAt = new Date("2026-01-01T00:00:00.000Z");
      const prepared = await runFoundationPhase({
        target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence, now: () => preparedAt,
      });
      try {
        const later = new Date(preparedAt.getTime() + 8 * 24 * 60 * 60 * 1_000);
        await expect(runFoundationPhase({
          target: localTarget, phase: "interrupt", scenario: "process-interrupt", evidence, now: () => later,
        }))
          .rejects.toThrow("STALE_QUALIFICATION_EVIDENCE");
        expect(groupAlive(prepared.processGroup!.groupId)).toBe(false);
      } finally {
        if (prepared.processGroup) try { process.kill(-prepared.processGroup.groupId, "SIGKILL"); } catch {}
        await rm(root, { recursive: true, force: true });
      }
    });

    test("durable state rejects a re-signed prepared boot mutation and reaps the group", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence });
      try {
        await writeFile(evidence, `${JSON.stringify(forgeEvidence(prepared, { preparedBootId: `forged-${prepared.preparedBootId}` }))}\n`);
        await expect(runFoundationPhase({ target: localTarget, phase: "interrupt", scenario: "process-interrupt", evidence }))
          .rejects.toThrow("QUALIFICATION_STATE_MISMATCH");
        expect(groupAlive(prepared.processGroup!.groupId)).toBe(false);
      } finally {
        if (prepared.processGroup) await stopGroup(prepared.processGroup.groupId);
        await rm(root, { recursive: true, force: true });
      }
    });

    test("re-signed reboot boot mutation cannot manufacture a reboot", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "reboot.json"));
      try {
        if (localTarget === "macos-github") {
          await expect(runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "reboot", evidence }))
            .rejects.toThrow("GitHub-hosted jobs cannot provide a physical-reboot witness");
          return;
        }
        const prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "reboot", evidence });
        await writeFile(evidence, `${JSON.stringify(forgeEvidence(prepared, { preparedBootId: `forged-${prepared.preparedBootId}` }))}\n`);
        await expect(runFoundationPhase({ target: localTarget, phase: "resume", scenario: "reboot", evidence }))
          .rejects.toThrow("QUALIFICATION_STATE_MISMATCH");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("durable state rejects a re-signed checkpoint sequence forgery before mutation", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence });
      try {
        const forged = forgeEvidence(prepared, {
          checkpoints: [{ phase: "verify", timestamp: prepared.createdAt, previousEvidenceHash: "0".repeat(64) }],
        });
        await writeFile(evidence, `${JSON.stringify(forged)}\n`);
        const before = await readFile(evidence, "utf8");
        await expect(runFoundationPhase({ target: localTarget, phase: "interrupt", scenario: "process-interrupt", evidence }))
          .rejects.toThrow("QUALIFICATION_STATE_MISMATCH");
        expect(await readFile(evidence, "utf8")).toBe(before);
        expect(groupAlive(prepared.processGroup!.groupId)).toBe(false);
      } finally {
        if (prepared.processGroup) await stopGroup(prepared.processGroup.groupId);
        await rm(root, { recursive: true, force: true });
      }
    });

    test("Darwin process identity requires matching leader, group, and nonce", () => {
      const nonce = "00000000-0000-4000-8000-000000000123";
      expect(matchesDarwinProcessIdentity(` 42 42 /usr/local/bin/node fixture.mjs qualification-hang marker ${nonce} atomic\n`, 42, nonce)).toBe(true);
      expect(matchesDarwinProcessIdentity(` 41 42 /usr/local/bin/node fixture.mjs ${nonce}\n`, 42, nonce)).toBe(false);
      expect(matchesDarwinProcessIdentity(` 42 41 /usr/local/bin/node fixture.mjs ${nonce}\n`, 42, nonce)).toBe(false);
      expect(matchesDarwinProcessIdentity(" 42 42 /usr/local/bin/node fixture.mjs different-nonce\n", 42, nonce)).toBe(false);
      expect(matchesDarwinProcessIdentity("not ps output", 42, nonce)).toBe(false);
      expect(matchesDarwinProcessIdentity(`42 42 /usr/local/bin/node fixture.mjs ${nonce}\n99 99 /bin/other\n`, 42, nonce)).toBe(false);
      expect(matchesDarwinGroupMemberIdentity(`99 42 /usr/local/bin/node fixture.mjs qualification-grandchild ${nonce}\n`, 42, nonce)).toBe(true);
      expect(matchesDarwinGroupMemberIdentity(`42 42 /usr/local/bin/node fixture.mjs ${nonce}\n99 42 /usr/local/bin/node fixture.mjs qualification-grandchild ${nonce}\n`, 42, nonce)).toBe(true);
      expect(matchesDarwinGroupMemberIdentity(`99 42 /usr/local/bin/node fixture.mjs prefix-${nonce}-suffix\n`, 42, nonce)).toBe(false);
      expect(matchesDarwinGroupMemberIdentity(`99 42 /usr/local/bin/node fixture.mjs ${nonce}\nmalformed\n`, 42, nonce)).toBe(false);
      expect(matchesDarwinGroupMemberIdentity(`99 41 /usr/local/bin/node fixture.mjs ${nonce}\n`, 42, nonce)).toBe(false);
      expect(classifyDarwinProcessGroup("", 42, nonce)).toBe("unknown");
      expect(classifyDarwinProcessGroup("99 99 /sbin/launchd\n", 42, nonce)).toBe("absent");
      expect(classifyDarwinProcessGroup(`99 42 /usr/local/bin/node fixture.mjs ${nonce}\n`, 42, nonce)).toBe("present");
      expect(classifyDarwinProcessGroup("99 42 /usr/local/bin/node fixture.mjs different-nonce\n", 42, nonce)).toBe("unknown");
      expect(classifyDarwinProcessGroup("not ps output", 42, nonce)).toBe("unknown");
    });

    test("an absent group before interrupt cannot produce passing evidence", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const unrefs = vi.spyOn(ChildProcess.prototype, "unref");
      const deletes = vi.spyOn(Map.prototype, "delete");
      const prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence });
      const leader = (unrefs.mock.contexts as ChildProcess[]).find((child) => child.pid === prepared.processGroup!.groupId)!;
      try {
        await stopGroup(prepared.processGroup!.groupId);
        const before = await readFile(evidence, "utf8");
        await expect(runFoundationPhase({ target: localTarget, phase: "interrupt", scenario: "process-interrupt", evidence }))
          .rejects.toThrow("PROCESS_INTERRUPT_NOT_OBSERVED");
        expect(await readFile(evidence, "utf8")).toBe(before);
        expect(deletes.mock.calls.some(([key]) => key === prepared.processGroup!.nonce)).toBe(true);
        expect(leader.listenerCount("exit")).toBe(0);
      } finally {
        deletes.mockRestore();
        unrefs.mockRestore();
        if (prepared.processGroup) await stopGroup(prepared.processGroup.groupId);
        await rm(root, { recursive: true, force: true });
      }
    });

    test("failure cleanup reaps an owned group after its leader exits", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence });
      const marker = JSON.parse(await readFile(join(prepared.workspace, "qualification-group.json"), "utf8")) as { childPid: number };
      try {
        const before = await readFile(evidence, "utf8");
        process.kill(prepared.processGroup!.groupId, "SIGKILL");
        await waitForProcessAbsent(prepared.processGroup!.groupId);
        expect(processAlive(prepared.processGroup!.groupId)).toBe(false);
        expect(processAlive(marker.childPid)).toBe(true);
        expect(groupAlive(prepared.processGroup!.groupId)).toBe(true);
        await expect(runFoundationPhase({ target: mismatchedTarget, phase: "interrupt", scenario: "process-interrupt", evidence }))
          .rejects.toThrow("QUALIFICATION_IDENTITY_MISMATCH");
        expect(await readFile(evidence, "utf8")).toBe(before);
        await waitForProcessAbsent(marker.childPid);
        expect(processAlive(marker.childPid)).toBe(false);
        expect(groupAlive(prepared.processGroup!.groupId)).toBe(false);
      } finally {
        if (prepared.processGroup) await stopGroup(prepared.processGroup.groupId);
        await rm(root, { recursive: true, force: true });
      }
    }, 20_000);

    test("copied prepared evidence cannot create a second lineage and leaves no group", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const first = relative(process.cwd(), join(root, "first.json"));
      const second = relative(process.cwd(), join(root, "second.json"));
      const prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence: first });
      try {
        await copyFile(first, second);
        await expect(runFoundationPhase({ target: localTarget, phase: "interrupt", scenario: "process-interrupt", evidence: second }))
          .rejects.toThrow("QUALIFICATION_LINEAGE_MISMATCH");
        expect(groupAlive(prepared.processGroup!.groupId)).toBe(false);
      } finally {
        if (prepared.processGroup) await stopGroup(prepared.processGroup.groupId);
        await rm(root, { recursive: true, force: true });
      }
    });

    test("one transition lease prevents concurrent resume counter loss", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence });
      try {
        await runFoundationPhase({ target: localTarget, phase: "interrupt", scenario: "process-interrupt", evidence });
        const outcomes = await Promise.allSettled([
          runFoundationPhase({ target: localTarget, phase: "resume", scenario: "process-interrupt", evidence }),
          runFoundationPhase({ target: localTarget, phase: "resume", scenario: "process-interrupt", evidence }),
        ]);
        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        expect(JSON.parse(await readFile(evidence, "utf8")).counters.resume).toBe(1);
      } finally {
        if (prepared.processGroup) await stopGroup(prepared.processGroup.groupId);
        await rm(root, { recursive: true, force: true });
      }
    });
  });
}
