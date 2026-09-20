import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { assertContainedPath, readBoundedFile, reserveStoredBytes, syncDirectory, verifyArtifact, writeAll } from "./artifacts.js";
import { codexSessionEvidenceSchema, nativeEvidenceSnapshotSchema, providerConfigurationHash, providerObservationSchema,
  ProviderFailure, type ProviderObservation, type ProviderRequest, type ProviderResult } from "./adapters/types.js";
import { CLAUDE_VERSION, decodeClaudeResult } from "./adapters/claude.js";
import { decodeCodexResult } from "./adapters/codex.js";
import { artifactRefSchema, assertRunId, canonicalJson, runManifestSchema, type JournalEvent, type Json } from "./contracts.js";

const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;

export type DurableEventType = JournalEvent["type"] | "workspace.captured" | "operation.prepared" | "dispatch.authorized" | "operation.committed"
  | "presentation.published" | "human.requested" | "human.reply-decided" | "approval.gate-opened" | "approval.gate-denied" | "approval.gate-stale" | "author.delivered"
  | "approval.effect-authorized" | "attempt.started" | "time.granted" | "time.refunded"
  | "cancel.requested" | "recovery.retry-authorized" | "run.cancelled" | "provider.observed";
export interface DurableEvent extends Omit<JournalEvent, "type"> {
  readonly type: DurableEventType;
}

const journalEventSchema = z.object({
  version: z.literal(2),
  runId: z.string(),
  sequence: z.number().int().positive(),
  ownershipGeneration: z.literal(1),
  timestamp: z.string().min(1),
  type: z.enum([
    "run.created", "run.initialized", "workspace.captured", "operation.prepared", "dispatch.authorized", "operation.committed",
    "presentation.published", "human.requested", "human.reply-decided", "approval.gate-opened", "approval.gate-denied", "approval.gate-stale", "author.delivered",
    "approval.effect-authorized", "attempt.started", "time.granted", "time.refunded", "cancel.requested", "recovery.retry-authorized",
    "run.succeeded", "run.failed", "run.cancelled", "provider.observed",
  ]),
  data: z.json(),
  previousHash: z.string().regex(/^[0-9a-f]{64}$/),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const eventDataSchemas = {
  "provider.observed": z.object({ observationArtifact: artifactRefSchema }).strict(),
  "run.created": runManifestSchema.extend({ supervisorPid: z.number().int().positive() }),
  "run.initialized": z.object({
    bundleArtifact: artifactRefSchema,
    inputArtifact: artifactRefSchema,
    initializationCharges: z.object({ compilations: z.literal(1), inputValidations: z.literal(1) }).strict(),
    supervisorPid: z.number().int().positive(),
    flowName: z.string().regex(/^[a-z0-9-]{1,64}$/).optional(),
  }).strict(),
  "attempt.started": z.object({ attempt: z.number().int().min(2), cause: z.literal("resume") }).strict(),
  "time.granted": z.object({ milliseconds: z.number().int().positive().max(1_000) }).strict(),
  "time.refunded": z.object({ milliseconds: z.number().int().positive().max(1_000) }).strict(),
  "workspace.captured": z.object({
    manifestArtifact: artifactRefSchema,
    limits: z.object({ maxCommands: z.number().int().nonnegative(), maxAgentCalls: z.number().int().nonnegative() }).strict(),
  }).strict(),
  "operation.prepared": z.object({
    ordinal: z.number().int().positive(),
    scope: z.literal("root"),
    kind: z.enum(["command", "agent", "read"]),
    request: z.json(),
    requestArtifact: artifactRefSchema.optional(),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
    preWorkspaceHash: z.string().regex(/^[0-9a-f]{64}$/),
    reservation: z.object({ commands: z.union([z.literal(0), z.literal(1)]), agentCalls: z.union([z.literal(0), z.literal(1)]) }).strict(),
  }).strict(),
  "dispatch.authorized": z.object({
    preparedHash: z.string().regex(/^[0-9a-f]{64}$/),
    ordinal: z.number().int().positive(),
    kind: z.enum(["command", "agent", "read"]),
  }).strict(),
  "operation.committed": z.object({
    preparedHash: z.string().regex(/^[0-9a-f]{64}$/),
    outcome: z.json(),
    outcomeArtifact: artifactRefSchema.optional(),
    postWorkspaceArtifact: artifactRefSchema,
    counters: z.object({ commands: z.number().int().nonnegative(), agentCalls: z.number().int().nonnegative() }).strict(),
  }).strict(),
  "presentation.published": z.object({
    presentationId: z.string().regex(/^[0-9a-f]{64}$/),
    presentationHash: z.string().regex(/^[0-9a-f]{64}$/),
    artifact: artifactRefSchema,
    evidence: z.array(artifactRefSchema).min(1).max(65),
  }).strict(),
  "human.requested": z.object({
    requestId: z.string().regex(/^[0-9a-f]{64}$/),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
    kind: z.enum(["ask", "approve", "recovery"]),
    requestArtifact: artifactRefSchema,
    evidence: z.array(artifactRefSchema).min(1).max(66),
    workspaceHash: z.string().regex(/^[0-9a-f]{64}$/),
    expiresAt: z.string().min(1),
  }).strict(),
  "human.reply-decided": z.object({
    requestId: z.string().regex(/^[0-9a-f]{64}$/),
    submissionId: z.string().min(1).max(128),
    semanticHash: z.string().regex(/^[0-9a-f]{64}$/),
    status: z.enum(["accepted", "rejected", "expired", "stale"]),
    value: z.json().optional(),
    envelopeArtifact: artifactRefSchema,
  }).strict(),
  "approval.gate-opened": z.object({
    requestId: z.string().regex(/^[0-9a-f]{64}$/),
    submissionId: z.string().min(1).max(128),
    workspaceHash: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  "author.delivered": z.object({
    requestId: z.string().regex(/^[0-9a-f]{64}$/),
    status: z.enum(["accepted", "rejected", "expired", "stale"]),
    error: z.literal("WORKSPACE_CHANGED").optional(),
  }).strict(),
  "approval.gate-denied": z.object({ requestId: z.string().regex(/^[0-9a-f]{64}$/), submissionId: z.string().min(1).max(128), workspaceHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  "approval.gate-stale": z.object({ requestId: z.string().regex(/^[0-9a-f]{64}$/), submissionId: z.string().min(1).max(128), workspaceHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  "approval.effect-authorized": z.object({
    requestId: z.string().regex(/^[0-9a-f]{64}$/),
    effectHash: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  "cancel.requested": z.object({
    cancellationId: z.string().min(1).max(128), reason: z.string().max(64 * 1024),
  }).strict(),
  "recovery.retry-authorized": z.object({
    requestId: z.string().regex(/^[0-9a-f]{64}$/), boundaryId: z.string().min(1),
    evidence: z.array(artifactRefSchema).min(1),
  }).strict(),
  "run.succeeded": z.object({ outputArtifact: artifactRefSchema }).strict(),
  "run.failed": z.object({ errorArtifact: artifactRefSchema }).strict(),
  "run.cancelled": z.object({ errorArtifact: artifactRefSchema }).strict(),
} as const;

export class Journal {
  readonly #path: string;
  readonly #runId: string;
  #sequence = 0;
  #previousHash = "0".repeat(64);
  #uncertain = false;

  constructor(runDirectory: string, runId: string, verifiedHistory: readonly DurableEvent[] = []) {
    this.#path = join(runDirectory, "events.jsonl");
    this.#runId = runId;
    const last = verifiedHistory.at(-1);
    if (last) {
      this.#sequence = last.sequence;
      this.#previousHash = last.hash;
    }
  }

  async append(type: DurableEventType, data: Json): Promise<DurableEvent> {
    if (this.#uncertain) throw new Error("Journal append outcome is uncertain");
    const sequence = this.#sequence + 1;
    const unsigned = {
      version: 2 as const,
      runId: this.#runId,
      sequence,
      ownershipGeneration: 1 as const,
      timestamp: new Date().toISOString(),
      type,
      data,
      previousHash: this.#previousHash,
    };
    const hash = createHash("sha256").update(canonicalJson(unsigned as unknown as Json)).digest("hex");
    const event: DurableEvent = { ...unsigned, hash };
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    if (bytes.length > MAX_EVENT_BYTES) throw new Error("Journal event exceeds 256 KiB limit");
    reserveStoredBytes(this.#path, bytes.length);
    try {
      const file = await open(this.#path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await writeAll(file, bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await syncDirectory(dirname(this.#path));
    } catch (error) {
      this.#uncertain = true;
      throw error;
    }
    this.#sequence = sequence;
    this.#previousHash = hash;
    return event;
  }
}

export async function readVerifiedEvents(workspace: string, runId: string): Promise<readonly DurableEvent[]> {
  assertRunId(runId);
  const runsDirectory = resolve(workspace, ".coding-flow", "runs");
  const path = resolve(runsDirectory, runId, "events.jsonl");
  if (relative(runsDirectory, path) !== join(runId, "events.jsonl")) throw new Error("Invalid run ID");
  await assertContainedPath(workspace, path);
  let bytes: Buffer;
  try {
    bytes = await readBoundedFile(path, MAX_JOURNAL_BYTES);
  } catch (error) {
    if (error instanceof Error && error.message.includes("exceeds")) throw new Error("Journal exceeds 8 MiB limit");
    throw error;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Corrupt journal");
  }
  if (!text.endsWith("\n")) throw new Error("Incomplete journal append");
  const events = text.slice(0, -1).split("\n").map((line) => {
    if (Buffer.byteLength(`${line}\n`, "utf8") > MAX_EVENT_BYTES) throw new Error("Journal event exceeds 256 KiB limit");
    try {
      const parsed = journalEventSchema.safeParse(JSON.parse(line));
      if (!parsed.success || !eventDataSchemas[parsed.data.type].safeParse(parsed.data.data).success) {
        throw new Error("Corrupt journal");
      }
      return parsed.data as DurableEvent;
    } catch {
      throw new Error("Corrupt journal");
    }
  });
  let previousHash = "0".repeat(64);
  let state: "empty" | "created" | "initialized" | "ready" | "prepared" | "authorized" | "waiting" | "decided" | "gated" | "terminal" = "empty";
  for (const [index, event] of events.entries()) {
    const { hash, ...unsigned } = event;
    const expected = createHash("sha256").update(canonicalJson(unsigned as unknown as Json)).digest("hex");
    if (event.runId !== runId || event.sequence !== index + 1 || event.previousHash !== previousHash || hash !== expected) {
      throw new Error("Corrupt journal");
    }
    if (event.type === "run.created" && state === "empty") state = "created";
    else if (event.type === "attempt.started" && state !== "empty" && state !== "terminal") state = state;
    else if ((event.type === "time.granted" || event.type === "time.refunded") && state !== "empty" && state !== "terminal") state = state;
    else if (event.type === "run.initialized" && state === "created") state = "initialized";
    else if (event.type === "workspace.captured" && state === "initialized") state = "ready";
    else if (event.type === "operation.prepared" && state === "ready") state = "prepared";
    else if (event.type === "dispatch.authorized" && state === "prepared") state = "authorized";
    else if (event.type === "operation.committed" && state === "authorized") state = "ready";
    else if (event.type === "provider.observed" && (state === "prepared" || state === "authorized")) state = state;
    else if (event.type === "presentation.published" && state === "ready") state = "ready";
    else if (event.type === "human.requested" && state === "ready") state = "waiting";
    else if (event.type === "human.reply-decided" && state === "waiting") state = "decided";
    else if ((event.type === "approval.gate-opened" || event.type === "approval.gate-denied" || event.type === "approval.gate-stale") && state === "decided") state = "gated";
    else if (event.type === "author.delivered" && (state === "decided" || state === "gated")) state = "ready";
    else if (event.type === "approval.effect-authorized" && state === "ready") state = "ready";
    else if (event.type === "cancel.requested" && state !== "empty" && state !== "terminal") state = state;
    else if (event.type === "recovery.retry-authorized" && state === "decided") state = "ready";
    else if (event.type === "run.succeeded" && (state === "initialized" || state === "ready")) state = "terminal";
    else if (event.type === "run.failed" && (state === "created" || state === "initialized" || state === "ready")) state = "terminal";
    else if (event.type === "run.cancelled" && state !== "empty" && state !== "terminal") state = "terminal";
    else throw new Error("Corrupt journal");
    previousHash = hash;
  }
  await readProviderObservations(dirname(path), events);
  return events;
}

export async function readProviderObservations(runDirectory: string, events: readonly DurableEvent[]): Promise<readonly ProviderObservation[]> {
  const observations: ProviderObservation[] = [];
  const keys = new Set<string>();
  let attempt = 1;
  let prepared: DurableEvent | undefined;
  let authorized = false;
  let agentOrdinal = 0;
  let terminalResult: { preparedHash: string; outcome: ProviderObservation["outcome"]; result?: ProviderResult; schema: boolean } | undefined;
  const created = events[0]?.data as { workspace?: string; runtime?: { provider?: string; model?: string } } | undefined;
  for (const event of events) {
    const data = event.data as Record<string, Json>;
    if (event.type === "attempt.started") attempt = Number(data.attempt);
    if (event.type === "operation.prepared") { prepared = event; authorized = false; if (data.kind === "agent") agentOrdinal += 1; }
    if (event.type === "dispatch.authorized") authorized = true;
    if (event.type === "operation.committed") {
      if (terminalResult && terminalResult.preparedHash === data.preparedHash) {
        const settled = data.outcomeArtifact
          ? JSON.parse((await verifyArtifact(runDirectory, artifactRefSchema.parse(data.outcomeArtifact))).toString("utf8")) as Record<string, unknown>
          : data.outcome as Record<string, unknown>;
        const expected = terminalResult.result && (terminalResult.schema ? terminalResult.result.structured : terminalResult.result.text);
        if (terminalResult.outcome === "succeeded") {
          if (settled?.status !== "resolved" || expected === undefined
            || canonicalJson(settled.value as Json) !== canonicalJson(expected as Json)) throw new Error("PROVIDER_EVIDENCE_MISMATCH");
        } else if (terminalResult.outcome === "PERMISSION_DENIED") {
          const error = settled?.error as Record<string, unknown> | undefined;
          if (settled?.status !== "rejected" || error?.code !== "PERMISSION_DENIED") throw new Error("PROVIDER_EVIDENCE_MISMATCH");
        }
      }
      terminalResult = undefined;
      prepared = undefined;
    }
    if (event.type !== "provider.observed") continue;
    const payload = JSON.parse((await verifyArtifact(runDirectory, artifactRefSchema.parse(data.observationArtifact))).toString("utf8"));
    const observation = providerObservationSchema.parse(payload);
    const binding = prepared?.data as Record<string, Json> | undefined;
    const key = canonicalJson([observation.runId, observation.preparedHash, observation.phase, observation.attempt, observation.ownershipGeneration]);
    if (!prepared || binding?.kind !== "agent" || prepared.hash !== observation.preparedHash || binding.ordinal !== observation.ordinal
      || event.runId !== observation.runId || event.ownershipGeneration !== observation.ownershipGeneration || attempt !== observation.attempt
      || authorized !== (observation.phase === "terminal") || keys.has(key)
      || observation.boundaryId !== `agent-${agentOrdinal}`
      || created?.runtime?.provider !== observation.provider || created.runtime.model !== observation.requestedModel) throw new Error("PROVIDER_EVIDENCE_MISMATCH");
    const request = binding.requestArtifact
      ? JSON.parse((await verifyArtifact(runDirectory, artifactRefSchema.parse(binding.requestArtifact))).toString("utf8")) as Json : binding.request!;
    if (observation.configurationSha256 !== providerConfigurationHash(observation.provider, observation.requestedModel, request, observation.executableSha256)) {
      throw new Error("PROVIDER_EVIDENCE_MISMATCH");
    }
    if (observation.phase === "preflight") {
      if (!["ready", "AUTH_REQUIRED", "AUTH_UNVERIFIED"].includes(observation.outcome)
        || (observation.outcome === "ready" && observation.auth !== "subscription")
        || (observation.outcome === "AUTH_REQUIRED" && observation.auth !== "logged-out")) throw new Error("PROVIDER_EVIDENCE_MISMATCH");
    } else {
      if (observation.outcome === "PERMISSION_DENIED" && (observation.provider !== "claude" || observation.executableVersion !== CLAUDE_VERSION)) throw new Error("PROVIDER_EVIDENCE_MISMATCH");
      const preflight = observations.filter((item) => item.phase === "preflight" && item.preparedHash === observation.preparedHash
        && item.attempt === observation.attempt && item.ownershipGeneration === observation.ownershipGeneration);
      if (preflight.length !== 1 || preflight[0]!.outcome !== "ready" || preflight[0]!.boundaryId !== observation.boundaryId
        || preflight[0]!.executableSha256 !== observation.executableSha256 || preflight[0]!.configurationSha256 !== observation.configurationSha256
        || preflight[0]!.executableVersion !== observation.executableVersion || preflight[0]!.auth !== observation.auth
        || observation.outcome === "ready" || observation.outcome === "AUTH_REQUIRED" || observation.outcome === "AUTH_UNVERIFIED") throw new Error("PROVIDER_EVIDENCE_MISMATCH");
      const operation = join(runDirectory, "operations", observation.boundaryId);
      const read = async (suffix: string): Promise<Record<string, unknown>> => {
        const path = `${operation}.${suffix}.json`;
        await assertContainedPath(runDirectory, path);
        return JSON.parse((await readBoundedFile(path, 64 * 1024 * 1024)).toString("utf8")) as Record<string, unknown>;
      };
      const [claim, registered, authorization] = await Promise.all([read("claim"), read("registered"), read("authorized")]);
      const returned = await read("committed");
      const { phase: _phase, outcome: _outcome, ...expectedBinding } = preflight[0]!;
      if ([claim, registered, authorization, returned].some((record) => canonicalJson((record.providerBinding ?? null) as Json) !== canonicalJson(expectedBinding as Json))) {
        throw new Error("PROVIDER_EVIDENCE_MISMATCH");
      }
      if (claim.attemptId !== observation.boundaryId || registered.attemptId !== observation.boundaryId || authorization.attemptId !== observation.boundaryId
        || !Number.isSafeInteger(registered.groupId) || Number(registered.groupId) <= 1 || typeof registered.nonce !== "string" || !registered.nonce
        || registered.groupId !== authorization.groupId || registered.nonce !== authorization.nonce
        || canonicalJson(claim as Json) !== canonicalJson(Object.fromEntries(Object.keys(claim).map((key) => [key, authorization[key]])) as Json)) throw new Error("PROVIDER_EVIDENCE_MISMATCH");
      if (!observation.nativeEvidenceArtifact) throw new Error("PROVIDER_EVIDENCE_MISMATCH");
      const snapshot = nativeEvidenceSnapshotSchema.parse(JSON.parse((await verifyArtifact(runDirectory, observation.nativeEvidenceArtifact)).toString("utf8")));
      if (snapshot.status.exitCode !== returned.exitCode || snapshot.status.signal !== returned.signal
        || snapshot.status.errorPresent !== (returned.error !== undefined)) throw new Error("PROVIDER_EVIDENCE_MISMATCH");
      const evidence = {
        version: 1 as const, captureContext: snapshot.captureContext, status: snapshot.status,
        stdout: snapshot.stdoutArtifact ? await verifyArtifact(runDirectory, snapshot.stdoutArtifact) : null,
        ...(snapshot.finalOutputArtifact ? { finalOutput: await verifyArtifact(runDirectory, snapshot.finalOutputArtifact) } : {}),
        ...(snapshot.codexSessionArtifact ? { codexSession: codexSessionEvidenceSchema.parse(JSON.parse(
          (await verifyArtifact(runDirectory, snapshot.codexSessionArtifact)).toString("utf8"))) } : {}),
      };
      const requestValue = request as Record<string, unknown>;
      const providerRequest: ProviderRequest = { prompt: String(requestValue.prompt), access: requestValue.access as "read" | "write",
        model: observation.requestedModel, workspace: created.workspace!, operationDirectory: join(runDirectory, "provider-attempts", observation.boundaryId),
        timeoutMs: Number(requestValue.timeoutMs),
        ...(typeof requestValue.schema === "object" && requestValue.schema !== null && !Array.isArray(requestValue.schema)
          ? { schema: requestValue.schema as Readonly<Record<string, Json>> } : {}) };
      let decoded: ProviderResult | undefined;
      let outcome: ProviderObservation["outcome"] = "OUTCOME_UNKNOWN";
      try {
        decoded = observation.provider === "codex" ? await decodeCodexResult(providerRequest, evidence)
          : await decodeClaudeResult(providerRequest, evidence);
        outcome = "succeeded";
      } catch (error) {
        if (error instanceof ProviderFailure && error.code === "PERMISSION_DENIED" && observation.provider === "claude") outcome = "PERMISSION_DENIED";
      }
      const digest = decoded?.sessionId ? createHash("sha256").update(`codeflow/provider-session/v1\0${observation.provider}\0${decoded.sessionId}`).digest("hex") : undefined;
      if (outcome !== observation.outcome || decoded?.actualModel !== observation.actualModel || digest !== observation.sessionIdSha256
        || canonicalJson((decoded?.usage ?? null) as Json) !== canonicalJson((observation.usage ?? null) as Json)) throw new Error("PROVIDER_EVIDENCE_MISMATCH");
      terminalResult = { preparedHash: observation.preparedHash, outcome, ...(decoded ? { result: decoded } : {}), schema: !!providerRequest.schema };
    }
    keys.add(key);
    observations.push(observation);
  }
  return observations;
}
