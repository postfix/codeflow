import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertContainedPath, publishBytes, publishJson, publishJsonOrReuse, readBoundedFile, refreshStoredBytes, remainingStoredBytes, reserveStoredBytes,
  syncDirectory, verifyArtifact, withStorageLimit, writeDurable,
} from "./artifacts.js";
import { buildFlow } from "./build.js";
import { copyJson, MAX_ARTIFACT_BYTES, MAX_JSON_BYTES, runManifestSchema, serializeError, startRequestSchema, type ArtifactRef, type Json, type StartRequest } from "./contracts.js";
import { CLAUDE_VERSION, claudeAdapter } from "./adapters/claude.js";
import { codexAdapter } from "./adapters/codex.js";
import {
  buildProviderInvocation, nativeEvidenceSnapshotSchema, preflightProvider, ProviderFailure, providerConfigurationHash, providerObservationSchema,
  type Adapter, type NativeProviderEvidence, type ProcessInvocation, type ProviderObservation, type ProviderRequest, type ProviderResult, type RuntimeStatus,
} from "./adapters/types.js";
import { type DurableEvent, Journal, readProviderObservations, readVerifiedEvents } from "./journal.js";
import { dispatchApprovedEffect, HumanCoordinator } from "./human.js";
import { commitRecoveryReply, completePendingRecoveryDecision, inspectRecoveryHistory, materializeRecoveryRequest } from "./recovery.js";
import { acquireOwnership } from "./ownership.js";
import { ProcessService, type ProcessRequest, type RegisteredProcess, type RunnerReturn } from "./process.js";
import { captureInitialWorkspace, CommittedRejection, ReplayFrontier, type PreparedOperationBinding } from "./replay.js";
import { readWorkspaceFile } from "./workspace.js";
import { initializeFlow, runFlow } from "./worker.js";

interface Initialization {
  readonly runId: string;
  readonly runDirectory: string;
  readonly workspace: string;
  readonly input: Json;
  readonly inputArtifact: ArtifactRef;
  readonly bundleArtifact: ArtifactRef;
  readonly bundle: URL;
  readonly journal: Journal;
  readonly history: readonly DurableEvent[];
  readonly entry: string;
  readonly runtime: { readonly provider: "codex" | "claude"; readonly executable?: string | undefined; readonly model?: string | undefined };
  readonly allowEdits: boolean;
  readonly hostLimits: Readonly<Record<string, number | undefined>>;
  readonly fakeAgentResults?: readonly Json[];
  readonly crashAt?: "after-human-reply" | "after-approval-gate" | "after-author-delivery" | "after-approval-effect";
}

function isJsonObject(value: unknown): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface OwnedCommandContext extends ProcessRequest {
  readonly service: ProcessService;
  readonly runDirectory: string;
  readonly providerBinding?: Omit<ProviderObservation, "phase" | "outcome">;
}

async function writeExclusiveDurable(path: string, bytes: Buffer): Promise<void> {
  reserveStoredBytes(path, bytes.length);
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(path));
}

async function claimAttempt(context: OwnedCommandContext): Promise<void> {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(context.attemptId)) throw new Error("Invalid process request");
  const directory = join(context.runDirectory, "operations");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await syncDirectory(context.runDirectory);
  try {
    await writeExclusiveDurable(join(directory, `${context.attemptId}.claim.json`), Buffer.from(JSON.stringify({
      attemptId: context.attemptId,
      executable: context.executable,
      args: context.args,
      cwd: context.cwd,
      stdinSha256: createHash("sha256").update(context.stdin ?? "").digest("hex"),
      ...(context.providerBinding ? { providerBinding: context.providerBinding } : {}),
    })));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error("ATTEMPT_EXISTS");
    throw error;
  }
}

async function commitRegistration(context: OwnedCommandContext, registered: RegisteredProcess): Promise<void> {
  const directory = join(context.runDirectory, "operations");
  await writeExclusiveDurable(join(directory, `${context.attemptId}.registered.json`), Buffer.from(JSON.stringify({
    attemptId: registered.attemptId,
    groupId: registered.groupId,
    nonce: registered.nonce,
    ...(context.providerBinding ? { providerBinding: context.providerBinding } : {}),
  })));
}

async function commitAuthorization(context: OwnedCommandContext, registered: RegisteredProcess): Promise<void> {
  await writeExclusiveDurable(join(context.runDirectory, "operations", `${context.attemptId}.authorized.json`), Buffer.from(JSON.stringify({
    attemptId: context.attemptId,
    executable: context.executable,
    args: context.args,
    cwd: context.cwd,
    stdinSha256: createHash("sha256").update(context.stdin ?? "").digest("hex"),
    groupId: registered.groupId,
    nonce: registered.nonce,
    ...(context.providerBinding ? { providerBinding: context.providerBinding } : {}),
  })));
}

export async function authorizeAttempt(context: OwnedCommandContext): Promise<{
  readonly registered: RegisteredProcess;
  readonly returned: RunnerReturn;
}> {
  await assertContainedPath(context.runDirectory, context.evidenceDirectory);
  if (!(await lstat(context.evidenceDirectory)).isDirectory()) throw new Error("EVIDENCE_CORRUPT");
  await claimAttempt(context);
  const registered = await context.service.register(context);
  try {
    await commitRegistration(context, registered);
    await commitAuthorization(context, registered);
    const maxOutputBytes = Math.min(MAX_ARTIFACT_BYTES, remainingStoredBytes(context.runDirectory));
    if (maxOutputBytes < 1) throw new Error("LIMIT_EXCEEDED");
    let returned: RunnerReturn;
    try {
      returned = await context.service.authorizeTarget(registered, {
        attemptId: context.attemptId,
        nonce: registered.nonce,
      }, maxOutputBytes);
    } finally {
      await refreshStoredBytes(context.runDirectory);
    }
    return { registered, returned };
  } catch (error) {
    await context.service.terminate(registered, "authorization failed");
    throw error;
  }
}

async function commitOutcome(context: OwnedCommandContext, returned: RunnerReturn): Promise<void> {
  await writeExclusiveDurable(join(context.runDirectory, "operations", `${context.attemptId}.committed.json`), Buffer.from(JSON.stringify({
    ...returned, ...(context.providerBinding ? { providerBinding: context.providerBinding } : {}),
  })));
}

function deliverOutcome(returned: RunnerReturn): RunnerReturn {
  return returned;
}

export async function commitOutcomeAndDeliver(
  context: OwnedCommandContext,
  registered: RegisteredProcess,
  returned: RunnerReturn,
): Promise<RunnerReturn> {
  await context.service.assertGroupAbsent(registered.identity);
  await commitOutcome(context, returned);
  return deliverOutcome(returned);
}

export async function executeOwnedCommand(context: OwnedCommandContext): Promise<RunnerReturn> {
  const { registered, returned } = await authorizeAttempt(context);
  return commitOutcomeAndDeliver(context, registered, returned);
}

async function publishArtifact(runDirectory: string, path: string, value: Json): Promise<ArtifactRef> {
  return publishJson(runDirectory, path, value);
}

async function appendEventWithArtifacts(journal: Journal, type: "run.succeeded" | "run.failed" | "run.cancelled", data: Json): Promise<DurableEvent> {
  return journal.append(type, data);
}

async function publishEventWithArtifacts(
  journal: Journal,
  runDirectory: string,
  path: string,
  value: Json,
  type: "run.succeeded" | "run.failed" | "run.cancelled",
  data: (artifact: ArtifactRef) => Json,
): Promise<{ readonly artifact: ArtifactRef; readonly event: DurableEvent }> {
  const artifact = await publishArtifact(runDirectory, path, value);
  const event = await appendEventWithArtifacts(journal, type, data(artifact));
  return { artifact, event };
}

async function publishCancelled(runDirectory: string, journal: Journal, reason: string): Promise<DurableEvent> {
  return (await publishEventWithArtifacts(
    journal, runDirectory, join(runDirectory, "artifacts", "cancelled.json"),
    { code: "CANCELLED", message: reason }, "run.cancelled",
    (errorArtifact) => ({ errorArtifact } as unknown as Json),
  )).event;
}

async function cancelOrphanedRun(request: Extract<StartRequest, { mode: "cancel" }>): Promise<void> {
  const runDirectory = join(request.workspace, ".coding-flow", "runs", request.runId);
  const history = await readVerifiedEvents(request.workspace, request.runId);
  process.send?.({ runId: request.runId });
  process.disconnect?.();
  if (history.some(({ type }) => type === "run.succeeded" || type === "run.failed" || type === "run.cancelled")) return;
  const service = new ProcessService();
  try {
    const operations = join(runDirectory, "operations");
    let names: string[] = [];
    try { names = await readdir(operations); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    for (const name of names.filter((item) => item.endsWith(".authorized.json"))) {
      const attemptId = name.slice(0, -".authorized.json".length);
      if (names.includes(`${attemptId}.committed.json`)) continue;
      const value = JSON.parse(await readFile(join(operations, name), "utf8")) as { groupId?: unknown; nonce?: unknown };
      if (!Number.isInteger(value.groupId) || typeof value.nonce !== "string") throw new Error("EVIDENCE_CORRUPT");
      await service.assertGroupAbsent({ groupId: Number(value.groupId), nonce: value.nonce });
    }
  } finally { await service.dispose(); }
  const journal = new Journal(runDirectory, request.runId, history);
  await journal.append("cancel.requested", { cancellationId: request.cancellationId, reason: request.reason });
  await publishCancelled(runDirectory, journal, request.reason || "Cancelled by host");
}

async function watchCancellation(
  runDirectory: string,
  journal: Journal,
  signal: AbortSignal,
  cancel: (reason: string) => Promise<void>,
): Promise<void> {
  const inbox = join(runDirectory, "cancel-inbox");
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  while (!signal.aborted) {
    for (const name of (await readdir(inbox)).sort()) {
      let value: unknown;
      try { value = JSON.parse((await readBoundedFile(join(inbox, name), 64 * 1024)).toString("utf8")); }
      catch { continue; }
      if (typeof value !== "object" || value === null || !("cancellationId" in value) || !("reason" in value)
        || typeof value.cancellationId !== "string" || typeof value.reason !== "string"
        || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.cancellationId)
        || Buffer.byteLength(value.reason, "utf8") > 64 * 1024) continue;
      await journal.append("cancel.requested", { cancellationId: value.cancellationId, reason: value.reason });
      await cancel(value.reason || "Cancelled by host");
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}

async function publishSuccessfulResult(runDirectory: string, terminal: DurableEvent): Promise<void> {
  const resultPath = join(runDirectory, "result.json");
  const bytes = Buffer.from(`${JSON.stringify(terminal)}\n`);
  try {
    await writeDurable(resultPath, bytes);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "LIMIT_EXCEEDED") throw error;
  }
}

async function createRun(request: Extract<ReturnType<typeof startRequestSchema.parse>, { mode: "start" }>): Promise<Initialization> {
  const runId = randomUUID();
  const runsDirectory = join(request.workspace, ".coding-flow", "runs");
  const runDirectory = join(runsDirectory, runId);
  const artifactsDirectory = join(runDirectory, "artifacts");
  await mkdir(runsDirectory, { recursive: true, mode: 0o700 });
  await assertContainedPath(request.workspace, runsDirectory);
  await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
  const input = copyJson(request.rawInput);
  const inputArtifact = await publishArtifact(runDirectory, join(artifactsDirectory, "input.json"), input);
  const fakeAgentResults = request.fakeAgentResults?.map(copyJson);
  const fakeAgentResultsArtifact = fakeAgentResults === undefined
    ? undefined
    : await publishArtifact(runDirectory, join(artifactsDirectory, "fake-agent-results.json"), fakeAgentResults);
  const built = await buildFlow(new URL(request.entry), runDirectory, request.workspace);
  const manifest = {
    runId,
    entry: request.entry,
    workspace: request.workspace,
    attempt: 1 as const,
    runtime: request.runtime,
    allowEdits: request.allowEdits,
    hostLimits: request.limits,
    inputArtifact,
    bundleArtifact: built.artifact,
    ...(fakeAgentResultsArtifact ? { fakeAgentResultsArtifact } : {}),
    initializationCharges: { compilations: 1 as const, inputValidations: 0 as const },
  };
  await publishJson(runDirectory, join(runDirectory, "manifest.json"), manifest as unknown as Json);
  const journal = new Journal(runDirectory, runId);
  const created = await journal.append("run.created", { ...manifest, supervisorPid: process.pid } as unknown as Json);
  for (const directory of [runDirectory, runsDirectory, join(request.workspace, ".coding-flow"), request.workspace]) {
    await syncDirectory(directory);
  }
  process.send?.({ runId });
  process.disconnect?.();
  if (request.crashAfterRunCreated === true) process.exit(91);
  return {
    runId, runDirectory, workspace: request.workspace, entry: request.entry,
    runtime: request.runtime, allowEdits: request.allowEdits, hostLimits: request.limits,
    input, inputArtifact, bundleArtifact: built.artifact,
    bundle: built.url, journal, history: [created],
    ...(fakeAgentResults ? { fakeAgentResults } : {}),
    ...(request.crashAt ? { crashAt: request.crashAt } : {}),
  };
}

async function resumeRun(request: Extract<ReturnType<typeof startRequestSchema.parse>, { mode: "resume" }>): Promise<Initialization> {
  const runDirectory = join(request.workspace, ".coding-flow", "runs", request.runId);
  const history = [...await readVerifiedEvents(request.workspace, request.runId)];
  if (history[0]?.type !== "run.created"
    || history.some(({ type }) => type === "run.succeeded" || type === "run.failed" || type === "run.cancelled")) {
    throw new Error("Run is not resumable");
  }
  const journal = new Journal(runDirectory, request.runId, history);
  if (await completePendingRecoveryDecision({
    runDirectory, workspace: request.workspace, runId: request.runId, journal, history,
  }) === "abandon") throw new Error("Run is not resumable");
  const manifest = runManifestSchema.parse(JSON.parse((await readBoundedFile(join(runDirectory, "manifest.json"), MAX_JSON_BYTES)).toString("utf8")));
  const created = runManifestSchema.passthrough().safeParse(history[0].data);
  if (!created.success || JSON.stringify(manifest) !== JSON.stringify({
    runId: created.data.runId,
    entry: created.data.entry,
    workspace: created.data.workspace,
    attempt: created.data.attempt,
    runtime: created.data.runtime,
    allowEdits: created.data.allowEdits,
    hostLimits: created.data.hostLimits,
    inputArtifact: created.data.inputArtifact,
    bundleArtifact: created.data.bundleArtifact,
    ...(created.data.fakeAgentResultsArtifact ? { fakeAgentResultsArtifact: created.data.fakeAgentResultsArtifact } : {}),
    initializationCharges: created.data.initializationCharges,
  })) throw new Error("Corrupt journal");
  if (created.data.runId !== request.runId || created.data.workspace !== request.workspace) throw new Error("Run identity mismatch");
  const inputBytes = await verifyArtifact(runDirectory, created.data.inputArtifact);
  await verifyArtifact(runDirectory, created.data.bundleArtifact);
  let fakeAgentResults: readonly Json[] | undefined;
  if (created.data.fakeAgentResultsArtifact) {
    const bytes = await verifyArtifact(runDirectory, created.data.fakeAgentResultsArtifact);
    const value = copyJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (!Array.isArray(value)) throw new Error("Corrupt journal");
    fakeAgentResults = value;
  }
  if (history.some(({ type }) => type === "run.initialized")) {
    const initialized = history.find(({ type }) => type === "run.initialized");
    const data = initialized?.data;
    if (initialized?.type !== "run.initialized" || !isJsonObject(data)
      || JSON.stringify(data.bundleArtifact) !== JSON.stringify(created.data.bundleArtifact)
      || JSON.stringify(data.inputArtifact) !== JSON.stringify(created.data.inputArtifact)) throw new Error("HISTORY_MISMATCH");
  }
  const input = copyJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inputBytes)));
  const previousAttempt = history.reduce((attempt, event) => event.type === "attempt.started"
    && isJsonObject(event.data) && typeof event.data.attempt === "number" ? Math.max(attempt, event.data.attempt) : attempt, 1);
  const attempt = await journal.append("attempt.started", {
    attempt: previousAttempt + 1, cause: "resume",
  });
  const resumedHistory = [...history, attempt];
  process.send?.({ runId: request.runId });
  process.disconnect?.();
  return {
    runId: request.runId,
    runDirectory,
    workspace: request.workspace,
    input,
    inputArtifact: created.data.inputArtifact,
    bundleArtifact: created.data.bundleArtifact,
    bundle: pathToFileURL(resolve(runDirectory, created.data.bundleArtifact.path)),
    journal: new Journal(runDirectory, request.runId, resumedHistory),
    history: resumedHistory,
    entry: created.data.entry,
    runtime: created.data.runtime,
    allowEdits: created.data.allowEdits,
    hostLimits: created.data.hostLimits,
    ...(fakeAgentResults ? { fakeAgentResults } : {}),
  };
}

function operationLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`Invalid ${name}`);
  return limit;
}

function object(value: Json): { readonly [key: string]: Json } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid worker boundary");
  return value as { readonly [key: string]: Json };
}

function stringArray(value: Json | undefined): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error("Invalid worker boundary");
  return value;
}

async function commandResult(runDirectory: string, returned: RunnerReturn): Promise<Json> {
  if (returned.exitCode === null || !returned.stdoutPath || !returned.stderrPath) {
    throw new CommittedRejection("COMMAND_FAILED", returned.error ?? `Command terminated by ${returned.signal ?? "unknown cause"}`);
  }
  await assertContainedPath(runDirectory, returned.stdoutPath);
  await assertContainedPath(runDirectory, returned.stderrPath);
  const stdout = await readBoundedFile(returned.stdoutPath, MAX_ARTIFACT_BYTES);
  const stderr = await readBoundedFile(returned.stderrPath, MAX_ARTIFACT_BYTES);
  const artifact = (path: string, bytes: Buffer): ArtifactRef => ({
    path: relative(runDirectory, path), sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length, mediaType: "text/plain; charset=utf-8",
  });
  return copyJson({
    exitCode: returned.exitCode, stdout: returned.stdout, stderr: returned.stderr, truncated: returned.truncated,
    stdoutArtifact: artifact(returned.stdoutPath, stdout), stderrArtifact: artifact(returned.stderrPath, stderr),
  });
}

async function providerExecutable(executable: string, cwd: string): Promise<{ path: string; sha256: string }> {
  const candidates = isAbsolute(executable) ? [executable] : executable.includes("/") ? [resolve(cwd, executable)]
    : (process.env.PATH ?? "").split(delimiter).map((directory) => resolve(directory || cwd, executable));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); }
    catch { continue; }
    const path = await realpath(candidate);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(path)) {
      bytes += chunk.length;
      if (bytes > 512 * 1024 * 1024) throw new Error("RUNTIME_UNQUALIFIED");
      hash.update(chunk);
    }
    return { path, sha256: hash.digest("hex") };
  }
  throw new Error("RUNTIME_UNQUALIFIED");
}

export async function dispatchProvider(context: {
  readonly adapter: Adapter;
  readonly service: ProcessService;
  readonly runDirectory: string;
  readonly attemptId: string;
  readonly request: ProviderRequest;
  readonly signal: AbortSignal;
  readonly perform: (dispatch: () => Promise<Json>, prepare: () => Promise<void>, afterPrepared: (binding: PreparedOperationBinding) => Promise<void>) => Promise<Json>;
  readonly prepare: () => Promise<void>;
  readonly observation?: { readonly workspace: string; readonly runId: string; readonly journal: Journal; readonly request: Json; readonly executable: string };
}): Promise<Json> {
  let invocation: ProcessInvocation | undefined;
  let base: Omit<ProviderObservation, "phase" | "outcome"> | undefined;
  const record = async (phase: ProviderObservation["phase"], outcome: ProviderObservation["outcome"], result?: ProviderResult,
    nativeEvidenceArtifact?: ArtifactRef): Promise<void> => {
    if (!context.observation || !base) return;
    const observation = providerObservationSchema.parse({ ...base, phase, outcome,
      ...(result?.actualModel ? { actualModel: result.actualModel } : {}),
      ...(result?.sessionId ? { sessionIdSha256: createHash("sha256").update(`codeflow/provider-session/v1\0${base.provider}\0${result.sessionId}`).digest("hex") } : {}),
      ...(result?.usage ? { usage: result.usage } : {}),
      ...(nativeEvidenceArtifact ? { nativeEvidenceArtifact } : {}),
    });
    const path = join(context.runDirectory, "artifacts", `provider-${base.ordinal}-${base.attempt}-${base.ownershipGeneration}-${phase}.json`);
    try {
      const observationArtifact = await publishJsonOrReuse(context.runDirectory, path, observation as unknown as Json);
      await context.observation.journal.append("provider.observed", { observationArtifact } as unknown as Json);
    } catch (error) { throw new Error(phase === "preflight" ? "STORAGE_UNAVAILABLE" : "OUTCOME_UNKNOWN", { cause: error }); }
  };
  return context.perform(async () => {
    if (!invocation) throw new Error("Provider invocation was not prepared");
    const startedAt = new Date().toISOString();
    const returned = await executeOwnedCommand({
      service: context.service,
      runDirectory: context.runDirectory,
      attemptId: context.attemptId,
      executable: invocation.executable,
      args: invocation.args,
      cwd: invocation.cwd,
      stdin: invocation.stdin,
      timeoutMs: context.request.timeoutMs,
      evidenceDirectory: context.request.operationDirectory,
      ...(base ? { providerBinding: base } : {}),
    });
    const returnedAt = new Date().toISOString();
    let evidence: NativeProviderEvidence;
    try { evidence = await context.adapter.capture(context.request, returned, { startedAt, returnedAt }); }
    catch (error) { throw new Error("OUTCOME_UNKNOWN", { cause: error }); }
    let nativeEvidenceArtifact: ArtifactRef;
    try {
      const stem = `provider-${base?.ordinal ?? 1}-${base?.attempt ?? 1}-${base?.ownershipGeneration ?? 1}`;
      const artifactPath = (suffix: string) => join(context.runDirectory, "artifacts", `${stem}-native-${suffix}`);
      const stdoutArtifact = evidence.stdout === null ? null
        : await publishBytes(context.runDirectory, artifactPath("stdout.bin"), evidence.stdout, "application/octet-stream");
      const finalOutputArtifact = evidence.finalOutput === undefined ? undefined
        : await publishBytes(context.runDirectory, artifactPath("final.bin"), evidence.finalOutput, "application/octet-stream");
      const codexSessionArtifact = evidence.codexSession === undefined ? undefined
        : await publishJsonOrReuse(context.runDirectory, artifactPath("session.json"), evidence.codexSession as unknown as Json);
      const snapshot = nativeEvidenceSnapshotSchema.parse({ version: 1, captureContext: evidence.captureContext, status: evidence.status,
        stdoutArtifact, ...(finalOutputArtifact ? { finalOutputArtifact } : {}),
        ...(codexSessionArtifact ? { codexSessionArtifact } : {}) });
      nativeEvidenceArtifact = await publishJsonOrReuse(context.runDirectory, artifactPath("snapshot.json"), snapshot as unknown as Json);
    } catch (error) { throw new Error("OUTCOME_UNKNOWN", { cause: error }); }
    let result;
    try { result = await context.adapter.decode(context.request, evidence); }
    catch (error) {
      const code = error instanceof ProviderFailure && error.code === "PERMISSION_DENIED" && base?.provider === "claude"
        && base.executableVersion === CLAUDE_VERSION ? "PERMISSION_DENIED" : "OUTCOME_UNKNOWN";
      await record("terminal", code, undefined, nativeEvidenceArtifact);
      if (code === "PERMISSION_DENIED") throw new CommittedRejection(code, "Provider denied permission");
      throw new Error("OUTCOME_UNKNOWN");
    }
    await record("terminal", "succeeded", result, nativeEvidenceArtifact);
    if (context.request.schema) {
      if (result.structured === undefined) throw new CommittedRejection("AGENT_FAILED", "Provider omitted structured output");
      return copyJson(result.structured);
    }
    if (result.text === undefined) throw new CommittedRejection("AGENT_FAILED", "Provider omitted text output");
    return result.text;
  }, context.prepare, async (binding) => {
    const observation = context.observation;
    let existing: ProviderObservation | undefined;
    let identity: { path: string; sha256: string } | undefined;
    let attempt = 1;
    let generation = 1;
    if (observation) {
      const history = await readVerifiedEvents(observation.workspace, observation.runId);
      attempt = 1 + history.filter(({ type }) => type === "attempt.started").length;
      generation = history.at(-1)!.ownershipGeneration;
      existing = (await readProviderObservations(context.runDirectory, history)).find((item) => item.preparedHash === binding.preparedHash
        && item.phase === "preflight" && item.attempt === attempt && item.ownershipGeneration === generation);
      identity = await providerExecutable(observation.executable, context.request.workspace);
      if (existing && existing.executableSha256 !== identity.sha256) throw new Error("PROVIDER_EVIDENCE_MISMATCH");
    }
    let status: RuntimeStatus | undefined;
    const adapter = { ...context.adapter, async status(signal: AbortSignal) {
      status = existing ? { provider: existing.provider, executable: identity!.path, version: existing.executableVersion, auth: existing.auth, qualified: true }
        : await context.adapter.status(signal);
      if (observation && identity && context.request.model) base = {
        provider: status.provider, runId: observation.runId, boundaryId: context.attemptId, ordinal: binding.ordinal, preparedHash: binding.preparedHash,
        attempt, ownershipGeneration: generation, executableSha256: identity.sha256,
        configurationSha256: providerConfigurationHash(status.provider, context.request.model, observation.request, identity.sha256),
        executableVersion: status.version, auth: status.auth, requestedModel: context.request.model,
      };
      return status;
    } };
    try { await preflightProvider(adapter, context.signal); }
    catch (error) {
      if (!existing && status?.qualified && error instanceof ProviderFailure) await record("preflight", error.code);
      throw error;
    }
    invocation = buildProviderInvocation(context.adapter, context.request);
    if (identity) invocation = { ...invocation, executable: identity.path };
    if (observation && !base) throw new Error("CONFIG_UNVERIFIED");
    if (existing && (existing.configurationSha256 !== base?.configurationSha256 || existing.boundaryId !== context.attemptId)) throw new Error("PROVIDER_EVIDENCE_MISMATCH");
    if (!existing) await record("preflight", "ready");
  });
}

export async function supervise(rawRequest: unknown): Promise<void> {
  const request = startRequestSchema.parse(rawRequest);
  const ownership = await acquireOwnership(request.workspace);
  try {
    if (request.mode === "cancel") {
      await cancelOrphanedRun(request);
      return;
    }
    if (request.mode === "recovery") {
      const runDirectory = join(request.workspace, ".coding-flow", "runs", request.runId);
      const history = [...await readVerifiedEvents(request.workspace, request.runId)];
      await commitRecoveryReply({
        runDirectory, workspace: request.workspace, runId: request.runId,
        journal: new Journal(runDirectory, request.runId, history), history, submissionId: request.submissionId,
      });
      process.send?.({ runId: request.runId });
      process.disconnect?.();
      return;
    }
    const initialization = request.mode === "start" ? await createRun(request) : await resumeRun(request);
    const { bundle, bundleArtifact, input, inputArtifact, journal, runDirectory, workspace } = initialization;
    const recovery = await inspectRecoveryHistory(runDirectory, initialization.history);
    if (recovery) {
      const history = [...initialization.history];
      const attempt = history.reduce((current, event) => event.type === "attempt.started"
        ? Math.max(current, Number(object(event.data).attempt)) : current, 1);
      await materializeRecoveryRequest({
        runDirectory, workspace, runId: initialization.runId, journal, history, state: recovery, attempt,
      });
      return;
    }
    const artifactsDirectory = join(runDirectory, "artifacts");
    let terminal: DurableEvent;
    let succeededTerminal: DurableEvent | undefined;
    let cancellationReason: string | undefined;
    try {
      const initialized = await initializeFlow(bundle, input, dirname(fileURLToPath(new URL(initialization.entry))));
      terminal = await withStorageLimit(
        runDirectory,
        Math.min(
          operationLimit(initialized.definition.limits?.maxStoredBytes, 512 * 1024 * 1024, "stored-byte limit"),
          operationLimit(initialization.hostLimits.maxStoredBytes, 512 * 1024 * 1024, "host stored-byte limit"),
        ),
        async () => {
          const limits = {
            maxCommands: Math.min(operationLimit(initialized.definition.limits?.maxCommands, 100, "command limit"),
              operationLimit(initialization.hostLimits.maxCommands, 100, "host command limit")),
            maxAgentCalls: Math.min(operationLimit(initialized.definition.limits?.maxAgentCalls, 20, "agent-call limit"),
              operationLimit(initialization.hostLimits.maxAgentCalls, 20, "host agent-call limit")),
          };
          const history = [...initialization.history];
          if (!history.some(({ type }) => type === "run.initialized")) {
            history.push(await journal.append("run.initialized", {
              bundleArtifact,
              inputArtifact,
              initializationCharges: { compilations: 1, inputValidations: 1 },
              supervisorPid: process.pid,
              ...(typeof initialized.definition.name === "string" ? { flowName: initialized.definition.name } : {}),
            } as unknown as Json));
          }
          if (!history.some(({ type }) => type === "workspace.captured")) {
            history.push(await captureInitialWorkspace(runDirectory, journal, workspace, limits, initialized.definition.disposablePaths));
          }
          const frontier = await ReplayFrontier.open({ runDirectory, runId: initialization.runId, journal, history, limits });
          const cancellation = new AbortController();
          const human = await HumanCoordinator.open({
            runDirectory, workspace, runId: initialization.runId, journal, history,
            ...(initialized.definition.disposablePaths ? { disposablePaths: initialized.definition.disposablePaths } : {}),
            ...(initialization.crashAt ? { crashAt: initialization.crashAt } : {}),
            signal: cancellation.signal,
          });
          const service = new ProcessService();
          const stopMonitor = new AbortController();
          let acceptingOperations = true;
          let commandOrdinal = 0;
          let fakeAgentOrdinal = 0;
          let output: Json;
          const monitor = watchCancellation(runDirectory, journal, stopMonitor.signal, async (reason) => {
            cancellationReason = reason;
            acceptingOperations = false;
            cancellation.abort();
            await service.dispose();
          });
          try {
            const execution = runFlow(initialized, workspace, {
              async command(request) {
                const boundary = object(request);
                if (typeof boundary.executable !== "string" || typeof boundary.cwd !== "string"
                  || typeof boundary.stdin !== "string" || typeof boundary.timeoutMs !== "number") throw new Error("Invalid worker boundary");
                const args = stringArray(boundary.args);
                const cwd = resolve(workspace, boundary.cwd);
                await assertContainedPath(workspace, cwd);
                commandOrdinal += 1;
                const dispatch = () => frontier.perform("command", request, async () => commandResult(runDirectory, await executeOwnedCommand({
                  service, runDirectory, attemptId: `command-${commandOrdinal}`, executable: boundary.executable as string,
                  args, cwd, stdin: boundary.stdin as string, timeoutMs: boundary.timeoutMs as number,
                  evidenceDirectory: runDirectory,
                })), () => acceptingOperations);
                return typeof boundary.approvalRequestId === "string"
                  ? dispatchApprovedEffect(human, boundary.approvalRequestId, request, dispatch)
                  : dispatch();
              },
              async agent(request) {
                const configuredOrdinal = fakeAgentOrdinal;
                fakeAgentOrdinal += 1;
                const configured = initialization.fakeAgentResults?.[configuredOrdinal];
                const perform = (body: () => Promise<Json>, prepare: () => Promise<void> = async () => undefined,
                  afterPrepared: (binding: PreparedOperationBinding) => Promise<void> = async () => undefined) =>
                  frontier.perform("agent", request, body, () => acceptingOperations, prepare, afterPrepared);
                const dispatch = configured !== undefined
                  ? () => perform(async () => copyJson(configured))
                  : async () => {
                  const boundary = object(request);
                  if (boundary.access !== "read" && boundary.access !== "write"
                    || typeof boundary.prompt !== "string" || typeof boundary.timeoutMs !== "number") {
                    throw new Error("Invalid worker boundary");
                  }
                  if (boundary.access === "write" && !initialization.allowEdits) {
                    throw new CommittedRejection("AGENT_UNAVAILABLE", "Write-capable agent access was not authorized at launch");
                  }
                  const attempts = join(runDirectory, "provider-attempts");
                  const operationDirectory = join(attempts, `agent-${String(configuredOrdinal + 1)}`);
                  const schemaValue = boundary.schema;
                  const schema = schemaValue === "text/v1" ? undefined
                    : isJsonObject(schemaValue) ? schemaValue : (() => { throw new Error("Invalid worker boundary"); })();
                  const runtime = initialization.runtime;
                  const adapter = runtime.provider === "codex"
                    ? codexAdapter(service, {
                      executable: runtime.executable, operationDirectory,
                    })
                    : claudeAdapter(service, {
                      executable: runtime.executable, operationDirectory,
                    });
                  return dispatchProvider({
                    adapter, service, runDirectory, attemptId: `agent-${String(configuredOrdinal + 1)}`,
                    observation: { workspace, runId: initialization.runId, journal, request, executable: runtime.executable ?? runtime.provider },
                    request: {
                      prompt: boundary.prompt as string,
                      ...(schema ? { schema } : {}),
                      access: boundary.access as "read" | "write",
                      ...(runtime.model ? { model: runtime.model } : {}),
                      workspace,
                      operationDirectory,
                      timeoutMs: boundary.timeoutMs as number,
                    },
                    signal: cancellation.signal,
                    perform,
                    async prepare() {
                      await mkdir(attempts, { recursive: true, mode: 0o700 });
                      const attemptsInfo = await lstat(attempts);
                      if (attemptsInfo.isSymbolicLink() || !attemptsInfo.isDirectory()) throw new Error("EVIDENCE_CORRUPT");
                      try { await mkdir(operationDirectory, { mode: 0o700 }); }
                      catch (error) {
                        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
                        const operationInfo = await lstat(operationDirectory);
                        if (operationInfo.isSymbolicLink() || !operationInfo.isDirectory()) throw new Error("EVIDENCE_CORRUPT");
                      }
                      await syncDirectory(attempts);
                      if (schema) {
                        const bytes = Buffer.from(JSON.stringify(schema));
                        if (bytes.length > 64 * 1024) {
                          throw new CommittedRejection("INVALID_AGENT_REQUEST", "Provider schema exceeds 64 KiB");
                        }
                        const path = join(operationDirectory, "schema.json");
                        try { await writeDurable(path, bytes); }
                        catch (error) {
                          if (!(error instanceof Error && error.message === "Artifact already exists")) throw error;
                          if (!(await readBoundedFile(path, 64 * 1024)).equals(bytes)) throw new Error("EVIDENCE_CORRUPT");
                        }
                      }
                    },
                  });
                };
                const boundary = object(request);
                return typeof boundary.approvalRequestId === "string"
                  ? dispatchApprovedEffect(human, boundary.approvalRequestId, request, dispatch)
                  : dispatch();
              },
              async read(request) {
                const boundary = object(request);
                if (typeof boundary.path !== "string") throw new Error("Invalid worker boundary");
                return frontier.perform("read", request, async () => readWorkspaceFile(workspace, boundary.path as string), () => acceptingOperations);
              },
              async human(request) { return human.perform(request); },
            }, cancellation.signal);
            output = await Promise.race([execution, monitor.then(() => {
              if (cancellationReason !== undefined) throw new Error("CANCELLED");
              return execution;
            })]);
            if (cancellationReason !== undefined) throw new Error("CANCELLED");
            frontier.assertConsumed();
            await frontier.assertFresh();
          } finally {
            acceptingOperations = false;
            stopMonitor.abort();
            await monitor;
            await service.dispose();
          }
          succeededTerminal = (await publishEventWithArtifacts(
            journal,
            runDirectory,
            join(artifactsDirectory, "output.json"),
            output,
            "run.succeeded",
            (outputArtifact) => ({ outputArtifact } as unknown as Json),
          )).event;
          await publishSuccessfulResult(runDirectory, succeededTerminal);
          return succeededTerminal;
        },
      );
    } catch (error) {
      if (succeededTerminal) throw error;
      if (cancellationReason !== undefined || (error instanceof Error && error.message === "CANCELLED")) {
        terminal = await publishCancelled(runDirectory, journal, cancellationReason ?? "Cancelled by host");
        await writeDurable(join(runDirectory, "result.json"), Buffer.from(`${JSON.stringify(terminal)}\n`));
        return;
      }
      if (error instanceof Error && /^(RUNTIME_|AUTH_)/.test(error.message)) throw error;
      if (error instanceof Error && ["OUTCOME_UNKNOWN", "APPROVED_EFFECT_UNKNOWN", "HISTORY_MISMATCH", "EVIDENCE_CORRUPT", "Workspace is stale"].includes(error.message)) throw error;
      ({ event: terminal } = await publishEventWithArtifacts(
        journal,
        runDirectory,
        join(artifactsDirectory, "error.json"),
        serializeError(error) as unknown as Json,
        "run.failed",
        (errorArtifact) => ({ errorArtifact } as unknown as Json),
      ));
      await writeDurable(join(runDirectory, "result.json"), Buffer.from(`${JSON.stringify(terminal)}\n`));
    }
  } finally {
    ownership.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const request = await new Promise<unknown>((resolveRequest) => process.once("message", resolveRequest));
  await supervise(request);
}
