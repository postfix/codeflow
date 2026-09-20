import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statfsSync, statSync } from "node:fs";
import { link, lstat, mkdir, open, rm, unlink } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assertContainedPath, publishJson, readBoundedFile, syncDirectory, verifyArtifact, writeDurable } from "./artifacts.js";
import { artifactRefSchema, canonicalJson, runManifestSchema, type Json } from "./contracts.js";
import type { RunOptions } from "./host.js";
import { Journal, readProviderObservations, readVerifiedEvents, type DurableEvent } from "./journal.js";
import { HumanCoordinator } from "./human.js";
import { ReplayFrontier } from "./replay.js";
import { buildFlow } from "./build.js";
import { CODEX_VERSION, decodeCodexAuth, decodeCodexResult } from "./adapters/codex.js";
import { CLAUDE_VERSION, decodeClaudeAuth, decodeClaudeResult } from "./adapters/claude.js";
import { preflightProvider, ProviderFailure, type Adapter, type ProviderRequest } from "./adapters/types.js";
import { acquireOwnership } from "./ownership.js";
import { inspectDarwinProcessGroup, probeProcessGroup, ProcessService } from "./process.js";
export { classifyDarwinProcessGroup, matchesDarwinGroupMemberIdentity, matchesDarwinProcessIdentity } from "./process.js";

export interface TestControl {
  readonly crashAfterRunCreated?: boolean;
  readonly fakeAgentResults?: readonly Json[];
  readonly crashAt?: "after-human-reply" | "after-approval-gate" | "after-author-delivery" | "after-approval-effect";
}

const controls = new WeakMap<object, TestControl>();

type TestRunOptions = RunOptions;

export function withTestControl<T extends TestRunOptions>(options: T, control: TestControl): T {
  const controlled = { ...options };
  controls.set(controlled, Object.freeze({ ...control }));
  return controlled as T;
}

export function readTestControl(options: object): TestControl | undefined {
  return controls.get(options);
}

const TARGETS = ["linux-local", "macos-github"] as const;
const PHASES = ["prepare", "interrupt", "resume", "verify"] as const;
const SCENARIOS = ["process-interrupt", "reboot"] as const;
const MAX_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const EXPECTED_NODE = "v24.19.0";
const FOUNDATION_SUBJECT = [
  "package.json",
  "package-lock.json",
  ".github/workflows/macos-foundation.yml",
  "src/ownership.ts",
  "src/process.ts",
  "src/artifacts.ts",
  "src/journal.ts",
  "src/testing.ts",
  "tests/qualification.test.ts",
  "tests/storage.test.ts",
  "tests/ownership-process.test.ts",
  "tests/fixtures/process-child.mjs",
] as const;

export type FoundationTarget = typeof TARGETS[number];
export type FoundationPhase = typeof PHASES[number];
export type FoundationScenario = typeof SCENARIOS[number];

function assertFoundationScenario(target: string, scenario: FoundationScenario): void {
  if (target === "macos-github" && scenario === "reboot") {
    throw new Error("MACOS_GITHUB_REBOOT_UNSUPPORTED: GitHub-hosted jobs cannot provide a physical-reboot witness");
  }
}

const identitySchema = z.object({
  node: z.literal(EXPECTED_NODE),
  fsExtVersion: z.string().min(1),
  fsExtBinarySha256: z.string().regex(/^[0-9a-f]{64}$/),
  platform: z.string().min(1),
  release: z.string().min(1),
  arch: z.string().min(1),
  filesystem: z.object({
    type: z.string().regex(/^0x[0-9a-f]+$/),
    blockSize: z.number().int().positive(),
    device: z.string().min(1),
    format: z.string().min(1),
  }).strict(),
  runnerImage: z.string().min(1).nullable(),
}).strict();

const countersSchema = z.object({
  prepare: z.number().int().nonnegative(),
  interrupt: z.number().int().nonnegative(),
  resume: z.number().int().nonnegative(),
  verify: z.number().int().nonnegative(),
}).strict();

const phaseSchema = z.enum(PHASES);
const evidenceSchema = z.object({
  version: z.literal(1),
  target: z.enum(TARGETS),
  scenario: z.enum(SCENARIOS),
  status: z.enum(["prepared", "interrupted", "resumed", "passed"]),
  nonce: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  preparedBootId: z.string().min(1),
  resumedBootId: z.string().min(1).nullable(),
  identity: identitySchema,
  foundationSha256: z.string().regex(/^[0-9a-f]{64}$/),
  workspace: z.string().min(1),
  runId: z.uuid(),
  inputArtifact: artifactRefSchema,
  bundleArtifact: artifactRefSchema,
  journalSha256: z.string().regex(/^[0-9a-f]{64}$/),
  stableLockExclusion: z.literal(true),
  processGroup: z.object({
    groupId: z.number().int().gt(1),
    nonce: z.uuid(),
    cleanup: z.enum(["pending", "absent", "uncertain"]),
    detail: z.string().min(1),
  }).strict().nullable(),
  counters: countersSchema,
  checkpoints: z.array(z.object({
    phase: phaseSchema,
    timestamp: z.iso.datetime(),
    previousEvidenceHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  }).strict()).min(1).max(4),
  evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type FoundationEvidence = z.infer<typeof evidenceSchema>;

export interface FoundationOptions {
  readonly target: FoundationTarget;
  readonly phase: FoundationPhase;
  readonly scenario: FoundationScenario;
  readonly evidence: string;
  readonly repository?: string;
  readonly now?: () => Date;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function evidenceHash(value: Omit<FoundationEvidence, "evidenceHash">): string {
  return sha256(canonicalJson(value as unknown as Json));
}

function signFoundationEvidence(value: Omit<FoundationEvidence, "evidenceHash">): FoundationEvidence {
  return { ...value, evidenceHash: evidenceHash(value) };
}

const stateSchema = evidenceSchema.pick({
  target: true,
  scenario: true,
  status: true,
  nonce: true,
  createdAt: true,
  preparedBootId: true,
  resumedBootId: true,
  workspace: true,
  runId: true,
  processGroup: true,
  counters: true,
  checkpoints: true,
  evidenceHash: true,
}).extend({ evidencePath: z.string().min(1) }).strict();

type FoundationState = z.infer<typeof stateSchema>;

function currentBootId(): string {
  if (platform() === "linux") return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (platform() === "darwin") return execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).trim();
  throw new Error("Unsupported qualification platform");
}

function unescapeMount(value: string): string {
  return value.replace(/\\040/g, " ").replace(/\\011/g, "\t").replace(/\\012/g, "\n").replace(/\\134/g, "\\");
}

function linuxFilesystemFormat(path: string, type: number): string {
  let selected: { readonly mountPoint: string; readonly format: string } | undefined;
  for (const line of readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n")) {
    const [left = "", right = ""] = line.split(" - ");
    const leftFields = left.split(" ");
    const rightFields = right.split(" ");
    const mountPoint = unescapeMount(leftFields[4] ?? "");
    const contained = mountPoint === sep || path === mountPoint || path.startsWith(`${mountPoint}${sep}`);
    if (!contained || (selected && selected.mountPoint.length >= mountPoint.length)) continue;
    selected = { mountPoint, format: rightFields[0] ?? "unknown" };
  }
  return selected?.format ?? `statfs-${type.toString(16)}`;
}

function filesystemIdentity(path: string): FoundationEvidence["identity"]["filesystem"] {
  const stats = statfsSync(path);
  const file = statSync(path);
  return {
    type: `0x${stats.type.toString(16)}`,
    blockSize: stats.bsize,
    device: String(file.dev),
    format: platform() === "linux" ? linuxFilesystemFormat(resolve(path), stats.type) : `statfs-${stats.type.toString(16)}`,
  };
}

export function assertFoundationTarget(
  target: string,
  identity: Pick<FoundationEvidence["identity"], "platform" | "release" | "filesystem">,
  scenario: FoundationScenario,
): asserts target is FoundationTarget {
  if (!(TARGETS as readonly string[]).includes(target)) throw new Error("TARGET_MISMATCH");
  assertFoundationScenario(target, scenario);
  if (target === "macos-github" && identity.platform !== "darwin") throw new Error("TARGET_MISMATCH");
  if (target === "linux-local" && identity.platform !== "linux") throw new Error("TARGET_MISMATCH");
  const filesystem = identity.filesystem.format.toLowerCase();
  if (filesystem.startsWith("fuse") || ["9p", "cifs", "nfs", "nfs4", "drvfs"].includes(filesystem)) throw new Error("FILESYSTEM_NOT_LOCAL");
}

async function currentIdentity(evidenceDirectory: string): Promise<FoundationEvidence["identity"]> {
  if (process.version !== EXPECTED_NODE) throw new Error(`NODE_MISMATCH: expected ${EXPECTED_NODE}, got ${process.version}`);
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("fs-ext/package.json");
  const packageValue = JSON.parse(readFileSync(packagePath, "utf8")) as { readonly version?: unknown };
  if (typeof packageValue.version !== "string") throw new Error("Invalid fs-ext package identity");
  const binaryPath = resolve(dirname(packagePath), "build", "Release", "fs_ext.node");
  const binary = await readBoundedFile(binaryPath, 16 * 1024 * 1024);
  return {
    node: EXPECTED_NODE,
    fsExtVersion: packageValue.version,
    fsExtBinarySha256: sha256(binary),
    platform: platform(),
    release: release(),
    arch: arch(),
    filesystem: filesystemIdentity(evidenceDirectory),
    runnerImage: process.env.ImageOS && process.env.ImageVersion ? `${process.env.ImageOS}@${process.env.ImageVersion}` : null,
  };
}

async function foundationHash(repository: string): Promise<string> {
  const hash = createHash("sha256");
  for (const path of FOUNDATION_SUBJECT) {
    const bytes = await readBoundedFile(join(repository, path), 64 * 1024 * 1024);
    hash.update(`${path}\0${String(bytes.length)}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

async function acquireQualificationLock(workspace: string): Promise<Awaited<ReturnType<typeof acquireOwnership>>> {
  const lease = await acquireOwnership(workspace);
  try {
    await acquireOwnership(workspace).then(
      (lease) => { lease.release(); throw new Error("Stable lock admitted a second owner"); },
      (error: unknown) => {
        if (!(error instanceof Error && error.message === "WORKSPACE_BUSY")) throw error;
      },
    );
    return lease;
  } catch (error) {
    lease.release();
    throw error;
  }
}

async function waitForPath(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("Qualification process did not become ready");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

const qualificationChildren = new Map<string, ChildProcess>();

async function waitForChildExit(child: ChildProcess): Promise<boolean> {
  child.ref();
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolveExit) => {
      const timeout = setTimeout(resolveExit, 5_000);
      child.once("exit", () => { clearTimeout(timeout); resolveExit(); });
    });
  }
  const exited = child.exitCode !== null || child.signalCode !== null;
  if (!exited) child.unref();
  return exited;
}

async function waitForQualificationChild(groupId: number, nonce: string): Promise<void> {
  const child = qualificationChildren.get(nonce);
  if (child?.pid !== groupId) return;
  await waitForChildExit(child);
}

async function reapStartedGroup(child: ChildProcess, groupId: number, nonce: string): Promise<void> {
  if (ownedGroupState(groupId, nonce) === "present") try { process.kill(-groupId, "SIGKILL"); } catch {}
  await waitForChildExit(child);
  const service = new ProcessService();
  try { await service.assertGroupAbsent({ groupId, nonce }); } catch {}
  finally { await service.dispose(); }
}

async function startQualificationGroup(repository: string, workspace: string): Promise<NonNullable<FoundationEvidence["processGroup"]>> {
  const nonce = randomUUID();
  const marker = join(workspace, "qualification-group.json");
  const fixture = join(repository, "tests", "fixtures", "process-child.mjs");
  const child = spawn(process.execPath, [fixture, "qualification-hang", marker, nonce, process.env.CODEFLOW_TEST_QUALIFICATION_MARKER ?? "atomic"], {
    cwd: workspace,
    detached: true,
    shell: false,
    stdio: "ignore",
  });
  if (child.pid === undefined) throw new Error("Qualification process did not start");
  try {
    await waitForPath(marker);
    const marked = JSON.parse((await readBoundedFile(marker, 4_096)).toString("utf8")) as Record<string, unknown>;
    if (marked.pid !== child.pid || marked.nonce !== nonce) throw new Error("Qualification process identity mismatch");
    qualificationChildren.set(nonce, child);
    const release = () => {
      child.off("exit", release);
      if (qualificationChildren.get(nonce) === child) qualificationChildren.delete(nonce);
    };
    if (child.exitCode !== null || child.signalCode !== null) release();
    else {
      child.once("exit", release);
      if (child.exitCode !== null || child.signalCode !== null) release();
    }
    child.unref();
    return { groupId: child.pid, nonce, cleanup: "pending", detail: "owned group is live" };
  } catch (error) {
    await reapStartedGroup(child, child.pid, nonce);
    throw error;
  }
}

function linuxStatProcessGroup(stat: string): number | undefined {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return undefined;
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
  if (fields.length < 3) return undefined;
  const processGroup = Number(fields[2]);
  return Number.isSafeInteger(processGroup) && processGroup > 0 ? processGroup : undefined;
}

function linuxGroupHasNonceMember(groupId: number, nonce: string): boolean {
  for (const processId of readdirSync("/proc")) {
    if (!/^\d+$/.test(processId)) continue;
    try {
      if (linuxStatProcessGroup(readFileSync(`/proc/${processId}/stat`, "utf8")) !== groupId) continue;
      if (readFileSync(`/proc/${processId}/cmdline`, "utf8").split("\0").includes(nonce)) return true;
    } catch {}
  }
  return false;
}

function ownedGroupStillMatches(groupId: number, nonce: string): boolean {
  if (platform() === "linux") {
    try {
      if (readFileSync(`/proc/${String(groupId)}/cmdline`, "utf8").split("\0").includes(nonce)) return true;
    } catch {}
    try { return linuxGroupHasNonceMember(groupId, nonce); } catch { return false; }
  }
  if (platform() === "darwin") {
    return inspectDarwinProcessGroup(groupId, nonce) === "present";
  }
  return false;
}

function ownedGroupState(groupId: number, nonce: string): ReturnType<typeof probeProcessGroup> {
  if (process.env.CODEFLOW_TEST_QUALIFICATION_GROUP_STATE === "unknown") return "unknown";
  const state = probeProcessGroup(groupId, nonce);
  if (state !== "present" || ownedGroupStillMatches(groupId, nonce)) return state;
  return probeProcessGroup(groupId) === "absent" ? "absent" : "unknown";
}

async function interruptQualificationGroup(group: NonNullable<FoundationEvidence["processGroup"]>, preparedBootId: string): Promise<NonNullable<FoundationEvidence["processGroup"]>> {
  if (currentBootId() !== preparedBootId) return { ...group, cleanup: "uncertain", detail: "boot changed; stale process identity was not signalled" };
  const state = ownedGroupState(group.groupId, group.nonce);
  if (state === "absent") throw new Error("PROCESS_INTERRUPT_NOT_OBSERVED");
  if (state === "unknown") return { ...group, cleanup: "uncertain", detail: "group presence could not be established" };
  process.kill(-group.groupId, "SIGTERM");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  const hardKillState = ownedGroupState(group.groupId, group.nonce);
  if (hardKillState === "unknown") {
    return { ...group, cleanup: "uncertain", detail: "owned group identity could not be revalidated; no SIGKILL sent" };
  }
  if (hardKillState === "present") try { process.kill(-group.groupId, "SIGKILL"); } catch {}
  await waitForQualificationChild(group.groupId, group.nonce);
  const service = new ProcessService();
  try {
    await service.assertGroupAbsent({ groupId: group.groupId, nonce: group.nonce });
    return { ...group, cleanup: "absent", detail: "owned group absent after interrupt cleanup" };
  } catch {
    return { ...group, cleanup: "uncertain", detail: "owned group absence could not be proved" };
  } finally {
    await service.dispose();
  }
}

async function reapQualificationGroup(group: FoundationEvidence["processGroup"], preparedBootId: string): Promise<void> {
  if (!group || currentBootId() !== preparedBootId) return;
  const state = ownedGroupState(group.groupId, group.nonce);
  if (state === "unknown") return;
  if (state === "present") try { process.kill(-group.groupId, "SIGKILL"); } catch {}
  await waitForQualificationChild(group.groupId, group.nonce);
  const service = new ProcessService();
  try { await service.assertGroupAbsent({ groupId: group.groupId, nonce: group.nonce }); } catch {}
  finally { await service.dispose(); }
}

async function durableFixture(workspace: string, runId: string): Promise<Pick<FoundationEvidence, "inputArtifact" | "bundleArtifact" | "journalSha256">> {
  const runDirectory = join(workspace, ".coding-flow", "runs", runId);
  const artifacts = join(runDirectory, "artifacts");
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const inputArtifact = await publishJson(runDirectory, join(artifacts, "input.json"), { qualification: "input" });
  const bundleArtifact = await publishJson(runDirectory, join(artifacts, "bundle.json"), { qualification: "bundle" });
  await new Journal(runDirectory, runId).append("run.created", {
    runId,
    entry: "file:///foundation-qualification",
    workspace,
    inputArtifact,
    bundleArtifact,
    initializationCharges: { compilations: 1, inputValidations: 0 },
    supervisorPid: process.pid,
  } as unknown as Json);
  for (const path of [runDirectory, dirname(runDirectory), dirname(dirname(runDirectory)), workspace]) await syncDirectory(path);
  const journal = await readBoundedFile(join(runDirectory, "events.jsonl"), 8 * 1024 * 1024);
  return { inputArtifact, bundleArtifact, journalSha256: sha256(journal) };
}

async function assertRecovered(evidence: FoundationEvidence): Promise<void> {
  const runDirectory = join(evidence.workspace, ".coding-flow", "runs", evidence.runId);
  const history = await readVerifiedEvents(evidence.workspace, evidence.runId);
  if (history.length !== 1 || history[0]?.type !== "run.created") throw new Error("QUALIFICATION_JOURNAL_MISMATCH");
  await verifyArtifact(runDirectory, evidence.inputArtifact);
  await verifyArtifact(runDirectory, evidence.bundleArtifact);
  const journal = await readBoundedFile(join(runDirectory, "events.jsonl"), 8 * 1024 * 1024);
  if (sha256(journal) !== evidence.journalSha256) throw new Error("QUALIFICATION_JOURNAL_MISMATCH");
}

async function writeEvidence(path: string, evidence: FoundationEvidence): Promise<void> {
  await writeDurable(path, Buffer.from(`${canonicalJson(evidence as unknown as Json)}\n`, "utf8"));
}

function stateFromEvidence(evidence: FoundationEvidence, evidencePath: string): FoundationState {
  return {
    target: evidence.target,
    scenario: evidence.scenario,
    status: evidence.status,
    nonce: evidence.nonce,
    createdAt: evidence.createdAt,
    preparedBootId: evidence.preparedBootId,
    resumedBootId: evidence.resumedBootId,
    workspace: evidence.workspace,
    runId: evidence.runId,
    processGroup: evidence.processGroup,
    counters: evidence.counters,
    checkpoints: evidence.checkpoints,
    evidenceHash: evidence.evidenceHash,
    evidencePath,
  };
}

function statePath(workspace: string): string {
  return join(workspace, "qualification-state.json");
}

async function writeState(state: FoundationState): Promise<void> {
  await writeDurable(statePath(state.workspace), Buffer.from(`${canonicalJson(state as unknown as Json)}\n`, "utf8"));
}

async function readState(evidence: FoundationEvidence): Promise<FoundationState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedFile(statePath(evidence.workspace), 64 * 1024)));
  } catch {
    throw new Error("INVALID_QUALIFICATION_STATE");
  }
  return stateSchema.parse(parsed);
}

async function readEvidence(path: string): Promise<FoundationEvidence> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedFile(path, 1024 * 1024)));
  } catch {
    throw new Error("INVALID_QUALIFICATION_EVIDENCE");
  }
  const evidence = evidenceSchema.parse(parsed);
  const { evidenceHash: found, ...unsigned } = evidence;
  if (found !== evidenceHash(unsigned)) throw new Error("INVALID_QUALIFICATION_EVIDENCE");
  return evidence;
}

function nextEvidence(evidence: FoundationEvidence, phase: FoundationPhase, changes: Partial<FoundationEvidence>, now: string): FoundationEvidence {
  const { evidenceHash: _, ...current } = evidence;
  const unsigned: Omit<FoundationEvidence, "evidenceHash"> = {
    ...current,
    ...changes,
    updatedAt: now,
    counters: { ...evidence.counters, [phase]: evidence.counters[phase] + 1 },
    checkpoints: [...evidence.checkpoints, { phase, timestamp: now, previousEvidenceHash: evidence.evidenceHash }],
  };
  return signFoundationEvidence(unsigned);
}

async function validateCurrent(evidence: FoundationEvidence, options: FoundationOptions, repository: string, evidenceDirectory: string): Promise<void> {
  if (evidence.target !== options.target || evidence.scenario !== options.scenario) throw new Error("QUALIFICATION_IDENTITY_MISMATCH");
  const now = (options.now ?? (() => new Date()))().getTime();
  if (now - Date.parse(evidence.createdAt) > MAX_EVIDENCE_AGE_MS || Date.parse(evidence.createdAt) > now + 60_000) throw new Error("STALE_QUALIFICATION_EVIDENCE");
  const identity = await currentIdentity(evidenceDirectory);
  assertFoundationTarget(options.target, identity, options.scenario);
  if (canonicalJson(identity as unknown as Json) !== canonicalJson(evidence.identity as unknown as Json)
    || await foundationHash(repository) !== evidence.foundationSha256) throw new Error("QUALIFICATION_IDENTITY_MISMATCH");
}

function expectedState(evidence: FoundationEvidence, phase: FoundationPhase): void {
  const expected = evidence.scenario === "process-interrupt"
    ? { interrupt: "prepared", resume: "interrupted", verify: "resumed" } as const
    : { interrupt: "never", resume: "prepared", verify: "resumed" } as const;
  if (phase === "prepare" || evidence.status !== expected[phase]) throw new Error("QUALIFICATION_PHASE_MISMATCH");
  const counts = phase === "interrupt" ? [1, 0, 0, 0]
    : phase === "resume" ? [1, evidence.scenario === "process-interrupt" ? 1 : 0, 0, 0]
      : [1, evidence.scenario === "process-interrupt" ? 1 : 0, 1, 0];
  if ([evidence.counters.prepare, evidence.counters.interrupt, evidence.counters.resume, evidence.counters.verify]
    .some((value, index) => value !== counts[index])) throw new Error("QUALIFICATION_COUNTER_MISMATCH");
}

function assertCheckpointShape(evidence: FoundationEvidence): void {
  const phases = evidence.scenario === "process-interrupt"
    ? {
        prepared: ["prepare"],
        interrupted: ["prepare", "interrupt"],
        resumed: ["prepare", "interrupt", "resume"],
        passed: ["prepare", "interrupt", "resume", "verify"],
      } as const
    : {
        prepared: ["prepare"],
        interrupted: [] as const,
        resumed: ["prepare", "resume"],
        passed: ["prepare", "resume", "verify"],
      } as const;
  const expected = phases[evidence.status];
  if (expected.length === 0 || evidence.checkpoints.length !== expected.length
    || evidence.checkpoints.some((checkpoint, index) => checkpoint.phase !== expected[index]
      || (index === 0 ? checkpoint.previousEvidenceHash !== null : checkpoint.previousEvidenceHash === null))) {
    throw new Error("QUALIFICATION_CHECKPOINT_MISMATCH");
  }
  const counters = evidence.counters;
  const expectedCounters = {
    prepare: 1,
    interrupt: evidence.scenario === "process-interrupt" && evidence.status !== "prepared" ? 1 : 0,
    resume: evidence.status === "resumed" || evidence.status === "passed" ? 1 : 0,
    verify: evidence.status === "passed" ? 1 : 0,
  };
  if (canonicalJson(counters as unknown as Json) !== canonicalJson(expectedCounters as unknown as Json)) {
    throw new Error("QUALIFICATION_CHECKPOINT_MISMATCH");
  }
}

export async function runFoundationPhase(options: FoundationOptions): Promise<FoundationEvidence> {
  assertFoundationScenario(options.target, options.scenario);
  const repository = resolve(options.repository ?? process.cwd());
  const evidencePath = resolve(options.evidence);
  const evidenceDirectory = dirname(evidencePath);
  const evidenceRelative = relative(repository, evidencePath);
  if (evidenceRelative === "" || evidenceRelative === ".." || evidenceRelative.startsWith(`..${sep}`)) throw new Error("Evidence must be inside the repository");
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  await assertContainedPath(repository, evidenceDirectory);

  if (options.phase === "prepare") {
    const preparationLease = await acquireOwnership(evidenceDirectory);
    try {
      await lstat(evidencePath).then(
        () => { throw new Error("QUALIFICATION_EVIDENCE_EXISTS"); },
        (error: unknown) => {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        },
      );
      const identity = await currentIdentity(evidenceDirectory);
      assertFoundationTarget(options.target, identity, options.scenario);
      const nonce = randomUUID();
      const workspace = join(evidenceDirectory, "workspaces", `${basename(evidencePath)}-${nonce}`);
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      const lease = await acquireQualificationLock(workspace);
      let processGroup: FoundationEvidence["processGroup"] = null;
      try {
        const runId = randomUUID();
        const durable = await durableFixture(workspace, runId);
        if (options.scenario === "process-interrupt") processGroup = await startQualificationGroup(repository, workspace);
        const now = (options.now ?? (() => new Date()))().toISOString();
        const evidence = signFoundationEvidence({
          version: 1,
          target: options.target,
          scenario: options.scenario,
          status: "prepared",
          nonce,
          createdAt: now,
          updatedAt: now,
          preparedBootId: currentBootId(),
          resumedBootId: null,
          identity,
          foundationSha256: await foundationHash(repository),
          workspace,
          runId,
          ...durable,
          stableLockExclusion: true,
          processGroup,
          counters: { prepare: 1, interrupt: 0, resume: 0, verify: 0 },
          checkpoints: [{ phase: "prepare", timestamp: now, previousEvidenceHash: null }],
        });
        assertCheckpointShape(evidence);
        await writeState(stateFromEvidence(evidence, evidenceRelative));
        await writeEvidence(evidencePath, evidence);
        return evidence;
      } catch (error) {
        await reapQualificationGroup(processGroup, currentBootId());
        throw error;
      } finally {
        lease.release();
      }
    } finally {
      preparationLease.release();
    }
  }

  const evidence = await readEvidence(evidencePath);
  const expectedWorkspace = join(evidenceDirectory, "workspaces", `${basename(evidencePath)}-${evidence.nonce}`);
  if (resolve(evidence.workspace) !== expectedWorkspace) {
    await reapQualificationGroup(evidence.processGroup, evidence.preparedBootId);
    throw new Error("QUALIFICATION_LINEAGE_MISMATCH");
  }
  const lease = await acquireQualificationLock(evidence.workspace);
  let preparedBootId = evidence.preparedBootId;
  try {
    const state = await readState(evidence);
    preparedBootId = state.preparedBootId;
    if (canonicalJson(state as unknown as Json) !== canonicalJson(stateFromEvidence(evidence, evidenceRelative) as unknown as Json)) {
      throw new Error("QUALIFICATION_STATE_MISMATCH");
    }
    assertCheckpointShape(evidence);
    await validateCurrent(evidence, options, repository, evidenceDirectory);
    expectedState(evidence, options.phase);
    await assertRecovered(evidence);

    let updated: FoundationEvidence;
    const now = (options.now ?? (() => new Date()))().toISOString();
    if (options.phase === "interrupt") {
      if (options.scenario !== "process-interrupt" || !evidence.processGroup) throw new Error("QUALIFICATION_PHASE_MISMATCH");
      const processGroup = await interruptQualificationGroup(evidence.processGroup, preparedBootId);
      if (processGroup.cleanup !== "absent") throw new Error("PROCESS_GROUP_ABSENCE_UNPROVED");
      updated = nextEvidence(evidence, "interrupt", { status: "interrupted", processGroup }, now);
    } else if (options.phase === "resume") {
      if (options.scenario === "reboot" && currentBootId() === preparedBootId) throw new Error("REBOOT_NOT_OBSERVED");
      if (options.scenario === "process-interrupt") {
        if (evidence.processGroup?.cleanup !== "absent") throw new Error("PROCESS_GROUP_ABSENCE_UNPROVED");
        const service = new ProcessService();
        try { await service.assertGroupAbsent(evidence.processGroup); }
        finally { await service.dispose(); }
      }
      updated = nextEvidence(evidence, "resume", { status: "resumed", resumedBootId: currentBootId() }, now);
    } else {
      if (evidence.scenario === "process-interrupt" && evidence.processGroup?.cleanup !== "absent") {
        throw new Error("PROCESS_GROUP_ABSENCE_UNPROVED");
      }
      updated = nextEvidence(evidence, "verify", { status: "passed" }, now);
    }
    await writeState(stateFromEvidence(updated, evidenceRelative));
    await writeEvidence(evidencePath, updated);
    return updated;
  } catch (error) {
    await reapQualificationGroup(evidence.processGroup, preparedBootId);
    throw error;
  } finally {
    lease.release();
  }
}

const liveDigest = z.string().regex(/^[0-9a-f]{64}$/);
const liveManifestSchema = z.object({
  version: z.literal(1), target: z.literal("linux-local"), provider: z.enum(["codex", "claude"]),
  fixtureSha256: liveDigest, fixtureSetSha256: liveDigest,
  runs: z.object({ happyPath: z.string().uuid(), interruptedRecovery: z.string().uuid(), cancellation: z.string().uuid() }).strict(),
  hostSteps: z.object({ provenance: z.literal("operator-asserted"), firstInvocationReceipt: z.string().min(1).max(256),
    reconnectedInvocationReceipt: z.string().min(1).max(256), contextClosedAndReopened: z.literal(true) }).strict(),
}).strict();
export type LiveAcceptanceManifestV1 = z.infer<typeof liveManifestSchema>;
export interface LiveAcceptanceOptions {
  readonly target: "linux-local";
  readonly provider: "codex" | "claude";
  readonly workspace: string;
  readonly manifest: string;
  readonly result: string;
}
export interface LiveAcceptanceEvidenceV1 {
  readonly version: 1;
  readonly requestedTarget: "linux-local";
  readonly provider: "codex" | "claude";
  readonly runtime: { readonly node: string; readonly os: "linux" };
  readonly subject: { readonly fixtureSha256: string; readonly fixtureSetSha256: string; readonly bundleSha256: string };
  readonly subscription: { readonly executableVersion: string; readonly auth: "subscription"; readonly requestedModel: string; readonly actualModel: string; readonly sessionIdSha256: string };
  readonly human: { readonly rejectionEffects: 0; readonly approvalEffects: 1 };
  readonly reconnection: { readonly sameRun: "verified"; readonly journalContinuity: "verified"; readonly contextRestart: "operator-asserted" };
  readonly recovery: { readonly resumedAfterSupervisorInterrupt: true; readonly committedRedispatches: 0; readonly limitsPreserved: true };
  readonly failures: { readonly preflightAuth: "fixture-qualified"; readonly claudePermission: "fixture-qualified"; readonly codexPostAuthorization: "conservative-unknown"; readonly claudeAuthOrQuota: "conservative-unknown"; readonly cancellation: "live-qualified" };
  readonly evidenceHash: string;
}

const LIVE_FIXTURE_SET = ["tests/fixtures/host-flow.ts", "tests/fixtures/codex.jsonl", "tests/fixtures/codex-session.json", "tests/fixtures/claude.jsonl", "tests/adapters.test.ts", "src/adapters/types.ts", "src/adapters/codex.ts", "src/adapters/claude.ts", "src/testing.ts"] as const;
export async function liveAcceptanceSubject(repository = process.cwd()): Promise<{ fixtureSha256: string; fixtureSetSha256: string }> {
  const hash = createHash("sha256");
  for (const path of LIVE_FIXTURE_SET) {
    const bytes = await readBoundedFile(join(repository, path), 64 * 1024 * 1024);
    hash.update(`${path}\0${bytes.length}\0`).update(bytes);
  }
  return { fixtureSha256: sha256(await readBoundedFile(join(repository, LIVE_FIXTURE_SET[0]), 64 * 1024 * 1024)), fixtureSetSha256: hash.digest("hex") };
}

function liveData(event: DurableEvent): Record<string, Json> {
  if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) throw new Error("LIVE_EVIDENCE_INVALID");
  return event.data as Record<string, Json>;
}

async function qualifyLiveFailureFixtures(workspace: string): Promise<void> {
  await assertContainedPath(workspace, join(workspace, ".coding-flow"));
  const directory = join(workspace, ".coding-flow", `provider-fixtures-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  const requireFailure = async (body: () => Promise<unknown>, code: string): Promise<void> => {
    try { await body(); }
    catch (error) {
      const actual = error instanceof ProviderFailure ? error.code : "OUTCOME_UNKNOWN";
      if (actual === code) return;
    }
    throw new Error("LIVE_FAILURE_FIXTURE_MISMATCH");
  };
  try {
    if (decodeCodexAuth("Not logged in") !== "logged-out" || decodeClaudeAuth('{"loggedIn":false}') !== "logged-out"
      || decodeClaudeAuth('{"loggedIn":true,"authMethod":"api_key","subscriptionType":"max"}') === "subscription") throw new Error("LIVE_FAILURE_FIXTURE_MISMATCH");
    for (const auth of ["logged-out", "unknown"] as const) {
      const adapter: Adapter = {
        async status() { return { provider: "codex", executable: "fixture", version: CODEX_VERSION, qualified: true, auth }; },
        invocation() { throw new Error("must not construct invocation"); }, async capture() { throw new Error("must not capture"); },
        async decode() { throw new Error("must not decode"); },
      };
      await requireFailure(() => preflightProvider(adapter, new AbortController().signal), auth === "logged-out" ? "AUTH_REQUIRED" : "AUTH_UNVERIFIED");
    }
    const request: ProviderRequest = { prompt: "fixture", access: "read", model: "fixture-model", workspace, operationDirectory: directory, timeoutMs: 1_000 };
    const now = new Date().toISOString();
    const evidence = (stdout: Uint8Array) => ({ version: 1 as const, captureContext: { startedAt: now, returnedAt: now },
      status: { exitCode: 0, signal: null, errorPresent: false }, stdout });
    const stdoutPath = join(directory, "permission.json");
    await writeDurable(stdoutPath, Buffer.from(`${JSON.stringify({ type: "system", subtype: "init", model: "fixture-model", session_id: "fixture-session" })}\n${JSON.stringify({ type: "result", subtype: "success", result: "ignored", permission_denials: ["Write"], session_id: "fixture-session" })}\n`));
    await requireFailure(async () => decodeClaudeResult(request, evidence(await readBoundedFile(stdoutPath, 1024 * 1024))), "PERMISSION_DENIED");
    for (const category of ["authentication expired", "quota exhausted"]) {
      const claude = join(directory, `${category.replaceAll(" ", "-")}.json`);
      await writeDurable(claude, Buffer.from(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: [category] })));
      await requireFailure(async () => decodeClaudeResult(request, evidence(await readBoundedFile(claude, 1024 * 1024))), "OUTCOME_UNKNOWN");
      const codex = `${claude}.jsonl`;
      await writeDurable(codex, Buffer.from(`${JSON.stringify({ type: "turn.failed", error: { message: category } })}\n`));
      await requireFailure(async () => decodeCodexResult(request, evidence(await readBoundedFile(codex, 1024 * 1024))), "OUTCOME_UNKNOWN");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function runLiveAcceptanceVerification(options: LiveAcceptanceOptions): Promise<LiveAcceptanceEvidenceV1> {
  if (process.platform !== "linux" || process.version !== EXPECTED_NODE || options.target !== "linux-local") throw new Error("RUNTIME_UNQUALIFIED");
  const workspace = resolve(options.workspace);
  const repository = process.cwd();
  const manifestPath = resolve(workspace, options.manifest);
  const resultPath = resolve(workspace, options.result);
  await assertContainedPath(workspace, manifestPath);
  await assertContainedPath(workspace, dirname(resultPath));
  if (!relative(workspace, resultPath).startsWith(`.coding-flow-qualification${sep}`)) throw new Error("LIVE_RESULT_PATH_INVALID");
  const manifest = liveManifestSchema.parse(JSON.parse((await readBoundedFile(manifestPath, 64 * 1024)).toString("utf8")));
  if (manifest.provider !== options.provider || manifest.target !== options.target || new Set(Object.values(manifest.runs)).size !== 3) throw new Error("LIVE_MANIFEST_MISMATCH");
  const subject = await liveAcceptanceSubject(repository);
  if (manifest.fixtureSha256 !== subject.fixtureSha256 || manifest.fixtureSetSha256 !== subject.fixtureSetSha256) throw new Error("LIVE_SUBJECT_MISMATCH");
  const fixture = (await readBoundedFile(join(repository, LIVE_FIXTURE_SET[0]), 1024 * 1024)).toString("utf8");
  const normalize = (source: string): string => source.replace(/from "[^"\n]*\/sdk\.js"/, 'from "coding-flow"');
  const histories = new Map<string, readonly DurableEvent[]>();
  const bundles = new Map<string, string>();
  let limits: string | undefined;
  let subscription: LiveAcceptanceEvidenceV1["subscription"] | undefined;
  let happyBundle = "";
  const verifyReferences = async (directory: string, value: Json): Promise<void> => {
    const artifact = artifactRefSchema.safeParse(value);
    if (artifact.success) { await verifyArtifact(directory, artifact.data); return; }
    if (Array.isArray(value)) for (const item of value) await verifyReferences(directory, item);
    else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) await verifyReferences(directory, item);
  };
  for (const [role, runId] of Object.entries(manifest.runs)) {
    const directory = join(workspace, ".coding-flow", "runs", runId);
    const history = await readVerifiedEvents(workspace, runId);
    histories.set(role, history);
    const first = history[0];
    if (!first || first.type !== "run.created") throw new Error("LIVE_HISTORY_MISSING");
    const { supervisorPid: _pid, ...createdValue } = liveData(first);
    const created = runManifestSchema.parse(createdValue);
    if (created.fakeAgentResultsArtifact || created.runtime.provider !== options.provider || created.workspace !== workspace || !created.runtime.model) throw new Error("LIVE_RUNTIME_MISMATCH");
    const age = Date.now() - Date.parse(first.timestamp);
    if (!Number.isFinite(age) || age < 0 || age > MAX_EVIDENCE_AGE_MS) throw new Error("LIVE_EVIDENCE_STALE");
    for (const event of history) await verifyReferences(directory, event.data);
    await HumanCoordinator.validateHistory(directory, history);
    const sourcePath = fileURLToPath(new URL(created.entry));
    await assertContainedPath(workspace, sourcePath);
    if (normalize((await readBoundedFile(sourcePath, 1024 * 1024)).toString("utf8")) !== normalize(fixture)) throw new Error("LIVE_FIXTURE_MISMATCH");
    let rebuilt = bundles.get(sourcePath);
    if (!rebuilt) {
      const scratch = join(workspace, ".coding-flow", `acceptance-build-${randomUUID()}`);
      try { rebuilt = (await buildFlow(new URL(created.entry), scratch, workspace)).artifact.sha256; }
      finally { await rm(scratch, { recursive: true, force: true }); }
      bundles.set(sourcePath, rebuilt);
    }
    if (created.bundleArtifact.sha256 !== rebuilt) throw new Error("LIVE_BUNDLE_MISMATCH");
    const input = z.object({ message: z.string(), delayMs: z.number(), acceptance: z.literal(true) }).strict().parse(
      JSON.parse((await verifyArtifact(directory, created.inputArtifact)).toString("utf8")));
    const captured = history.filter(({ type }) => type === "workspace.captured");
    if (captured.length !== 1) throw new Error("LIVE_LIMITS_MISMATCH");
    const capturedLimits = liveData(captured[0]!).limits as { maxCommands: number; maxAgentCalls: number };
    const currentLimits = canonicalJson({ capturedLimits, hostLimits: created.hostLimits } as unknown as Json);
    if (limits !== undefined && limits !== currentLimits) throw new Error("LIVE_LIMITS_MISMATCH");
    limits = currentLimits;
    await ReplayFrontier.open({ runDirectory: directory, runId, journal: new Journal(directory, runId, history), history, limits: capturedLimits });
    const terminal = history.at(-1)!;
    if (role === "cancellation") {
      if (terminal.type !== "run.cancelled" || history.filter(({ type }) => type === "cancel.requested").length !== 1) throw new Error("LIVE_CANCELLATION_MISSING");
      continue;
    }
    if (terminal.type !== "run.succeeded") throw new Error("LIVE_SUCCESS_MISSING");
    const output = JSON.parse((await verifyArtifact(directory, artifactRefSchema.parse(liveData(terminal).outputArtifact))).toString("utf8")) as Json;
    if (canonicalJson(output) !== canonicalJson({ echoed: input.message })) throw new Error("LIVE_OUTPUT_MISMATCH");
    const decisions = history.filter(({ type }) => type === "human.reply-decided");
    const denied = history.filter(({ type }) => type === "approval.gate-denied");
    const opened = history.filter(({ type }) => type === "approval.gate-opened");
    const effects = history.filter(({ type }) => type === "approval.effect-authorized");
    if (denied.length !== 1 || opened.length !== 1 || effects.length !== 1 || decisions.length !== 3
      || liveData(denied[0]!).requestId === liveData(opened[0]!).requestId || liveData(effects[0]!).requestId !== liveData(opened[0]!).requestId
      || denied[0]!.sequence >= opened[0]!.sequence || opened[0]!.sequence >= effects[0]!.sequence) throw new Error("LIVE_CONSENT_MISMATCH");
    const commands = history.filter((event) => event.type === "operation.prepared" && liveData(event).kind === "command");
    if (commands.length !== 1 || commands[0]!.sequence <= effects[0]!.sequence) throw new Error("LIVE_EFFECT_COUNT_MISMATCH");
    const committed = history.filter((event) => event.type === "operation.committed" && liveData(event).preparedHash === commands[0]!.hash);
    if (committed.length !== 1) throw new Error("LIVE_EFFECT_COUNT_MISMATCH");
    const post = JSON.parse((await verifyArtifact(directory, artifactRefSchema.parse(liveData(committed[0]!).postWorkspaceArtifact))).toString("utf8")) as { files?: { path: string; sha256: string }[] };
    if (post.files?.find(({ path }) => path === "acceptance-effect.txt")?.sha256 !== sha256(Buffer.from(`${input.message}\n`))) throw new Error("LIVE_EDIT_MISMATCH");
    const observations = await readProviderObservations(directory, history);
    const terminals = observations.filter(({ phase }) => phase === "terminal");
    if (observations.length !== 2 || terminals.length !== 1) throw new Error("LIVE_PROVIDER_OBSERVATION_MISSING");
    const provider = terminals[0]!;
    if (provider.outcome !== "succeeded" || provider.auth !== "subscription" || !provider.sessionIdSha256
      || provider.actualModel !== provider.requestedModel || provider.executableVersion !== (options.provider === "codex" ? CODEX_VERSION : CLAUDE_VERSION)) throw new Error("LIVE_SUBSCRIPTION_UNVERIFIED");
    if (role === "happyPath") {
      happyBundle = created.bundleArtifact.sha256;
      subscription = { executableVersion: provider.executableVersion, auth: "subscription", requestedModel: provider.requestedModel,
        actualModel: provider.actualModel, sessionIdSha256: provider.sessionIdSha256 };
    } else {
      const resumes = history.filter(({ type }) => type === "attempt.started");
      if (resumes.length !== 1 || liveData(resumes[0]!).attempt !== 2 || resumes[0]!.sequence <= committed[0]!.sequence
        || history.some((event) => event.sequence > resumes[0]!.sequence && ["dispatch.authorized", "operation.prepared", "provider.observed"].includes(event.type))) throw new Error("LIVE_RECOVERY_MISMATCH");
    }
  }
  const happy = histories.get("happyPath")!;
  const receipt = (text: string): DurableEvent => {
    const [runId, sequence, hash, extra] = text.split(":");
    const event = happy.find((event) => event.sequence === Number(sequence));
    if (extra !== undefined || runId !== manifest.runs.happyPath || !event || event.hash !== hash) throw new Error("LIVE_RECONNECT_MISMATCH");
    return event;
  };
  if (receipt(manifest.hostSteps.firstInvocationReceipt).sequence >= receipt(manifest.hostSteps.reconnectedInvocationReceipt).sequence) throw new Error("LIVE_RECONNECT_MISMATCH");
  if (!subscription) throw new Error("LIVE_SUBSCRIPTION_UNVERIFIED");
  await qualifyLiveFailureFixtures(workspace);
  const unsigned: Omit<LiveAcceptanceEvidenceV1, "evidenceHash"> = {
    version: 1, requestedTarget: "linux-local", provider: options.provider, runtime: { node: process.version, os: "linux" },
    subject: { ...subject, bundleSha256: happyBundle }, subscription,
    human: { rejectionEffects: 0, approvalEffects: 1 },
    reconnection: { sameRun: "verified", journalContinuity: "verified", contextRestart: "operator-asserted" },
    recovery: { resumedAfterSupervisorInterrupt: true, committedRedispatches: 0, limitsPreserved: true },
    failures: { preflightAuth: "fixture-qualified", claudePermission: "fixture-qualified", codexPostAuthorization: "conservative-unknown", claudeAuthOrQuota: "conservative-unknown", cancellation: "live-qualified" },
  };
  const evidence: LiveAcceptanceEvidenceV1 = { ...unsigned, evidenceHash: sha256(Buffer.from(canonicalJson(unsigned as unknown as Json))) };
  const temporary = join(dirname(resultPath), `.live-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(`${canonicalJson(evidence as unknown as Json)}\n`); await file.sync(); }
  finally { await file.close(); }
  try { await link(temporary, resultPath); }
  finally { await unlink(temporary); }
  await syncDirectory(dirname(resultPath));
  return evidence;
}
