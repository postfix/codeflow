import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statfsSync, statSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";
import { assertContainedPath, publishJson, readBoundedFile, syncDirectory, verifyArtifact, writeDurable } from "./artifacts.js";
import { artifactRefSchema, canonicalJson, type Json } from "./contracts.js";
import type { RunOptions } from "./host.js";
import { Journal, readVerifiedEvents } from "./journal.js";
import { acquireOwnership } from "./ownership.js";
import { inspectDarwinProcessGroup, probeProcessGroup, ProcessService } from "./process.js";
export { classifyDarwinProcessGroup, matchesDarwinGroupMemberIdentity, matchesDarwinProcessIdentity } from "./process.js";

export interface TestControl {
  readonly crashAfterRunCreated?: boolean;
}

const controls = new WeakMap<object, TestControl>();

export function withTestControl(options: RunOptions, control: TestControl): RunOptions {
  const controlled = { ...options };
  controls.set(controlled, Object.freeze({ ...control }));
  return controlled;
}

export function readTestControl(options: RunOptions): TestControl | undefined {
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
  const release = () => {
    if (qualificationChildren.get(nonce) === child) qualificationChildren.delete(nonce);
  };
  child.once("exit", release);
  if (await waitForChildExit(child)) release();
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
