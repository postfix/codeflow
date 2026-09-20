import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { flockSync } from "fs-ext";
import { assertContainedPath, syncDirectory, verifyArtifact, writeAll } from "./artifacts.js";
import {
  artifactRefSchema, assertRunId, canonicalJson, copyJson, errorCodeSchema, internalHumanReplySchema, runManifestSchema,
  type ArtifactRef, type InternalHumanReply, type Json, type StartRequest,
} from "./contracts.js";
import {
  currentHumanRequest, findHistoricalReceipt, humanRequestById,
  type HumanRequest as InternalHumanRequest,
} from "./human.js";
import { readVerifiedEvents, type DurableEvent } from "./journal.js";
import { inspectRecoveryHistory, recoveryReplyApplied } from "./recovery.js";
import type { Limits, Provider } from "./sdk.js";
import { readTestControl } from "./testing.js";

export type BlockCode =
  | "OUTCOME_UNKNOWN" | "OWNER_UNVERIFIED" | "CODE_CHANGED" | "WORKSPACE_CHANGED"
  | "HISTORY_MISMATCH" | "EVIDENCE_CORRUPT" | "STORAGE_UNAVAILABLE" | "CLOCK_UNVERIFIED"
  | "RECOVERY_LIMIT" | "RUNTIME_MISSING" | "RUNTIME_UNQUALIFIED" | "AUTH_REQUIRED"
  | "AUTH_CONFLICT" | "AUTH_UNVERIFIED" | "QUOTA_EXCEEDED" | "CONFIG_UNVERIFIED"
  | "STORAGE_UNSUPPORTED" | "WORKSPACE_LIMIT" | "INSTALLATION_MISMATCH";
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export interface FlowErrorData {
  readonly code: ErrorCode;
  readonly message: string;
  readonly boundaryId?: string;
  readonly attempt?: number;
  readonly details?: Json;
}
export interface RuntimeConfig { readonly provider: Provider; readonly executable?: string; readonly model?: string }
export interface RunOptions {
  readonly workspace: string;
  readonly runtime: RuntimeConfig;
  readonly allowEdits?: boolean;
  readonly limits?: Limits;
  readonly signal?: AbortSignal;
}
export interface HumanRequestBase {
  readonly requestId: string;
  readonly revision: string;
  readonly title: string;
  readonly presentation: ArtifactRef;
  readonly presentationHash: string;
  readonly expiresAt: string;
}
export type RecoveryChoice = "accept-return" | "retry-no-application" | "abandon";
export type HumanRequest = HumanRequestBase & (
  | { readonly kind: "question"; readonly schema: Readonly<Record<string, Json>> }
  | { readonly kind: "approval"; readonly action: Json; readonly workspaceHash: string }
  | { readonly kind: "recovery"; readonly boundaryId: string; readonly attempt: number; readonly action: Json;
      readonly workspaceHash: string; readonly choices: readonly RecoveryChoice[] }
);
export interface HumanReply {
  readonly submissionId: string;
  readonly requestId: string;
  readonly revision: string;
  readonly presentationHash: string;
  readonly answer: Json;
}
export interface ReplyReceipt {
  readonly submissionId: string;
  readonly status: "accepted" | "invalid" | "already-applied" | "rejected" | "uncertain";
  readonly diagnostics?: readonly string[];
}
export interface RunSummary {
  readonly version: 2;
  readonly runId: string;
  readonly flowName: string | null;
  readonly entry: string;
  readonly attempt: number;
  readonly evidenceDirectory: string;
  readonly agentCalls: number;
  readonly commands: number;
  readonly activeMsCharged: number;
  readonly partialEffectsPossible: boolean;
}
export type RunBoundary = RunSummary & (
  | { readonly status: "starting" | "running" | "recovering" }
  | { readonly status: "waiting-for-human"; readonly request: HumanRequest }
  | { readonly status: "interrupted"; readonly lastCommittedSequence: number }
  | { readonly status: "blocked"; readonly reason: BlockCode; readonly message: string; readonly evidence: readonly ArtifactRef[] }
  | { readonly status: "succeeded"; readonly output: Json; readonly outputArtifact: ArtifactRef }
  | { readonly status: "failed" | "cancelled" | "timed-out"; readonly error: FlowErrorData }
);
export interface RunHandle {
  readonly runId: string;
  wait(timeoutMs?: number): Promise<RunBoundary>;
  respond(reply: HumanReply): Promise<ReplyReceipt>;
  cancel(reason?: string): Promise<RunBoundary>;
}

const runtimeSchema = z.object({
  provider: z.enum(["codex", "claude"]), executable: z.string().min(1).optional(), model: z.string().min(1).optional(),
}).strict();
const publicReplySchema = z.object({
  submissionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  requestId: z.string().regex(/^[0-9a-f]{64}$/), revision: z.string().regex(/^[0-9a-f]{64}$/),
  presentationHash: z.string().regex(/^[0-9a-f]{64}$/), answer: z.json(),
}).strict();
const terminalDataSchema = z.object({ outputArtifact: artifactRefSchema }).strict();
const errorDataSchema = z.object({ errorArtifact: artifactRefSchema }).strict();
const serializedErrorSchema = z.object({ code: errorCodeSchema, message: z.string() }).strict();

function supervisorPath(): string {
  const current = fileURLToPath(import.meta.url);
  return extname(current) === ".ts" ? resolve(dirname(current), "../dist/src/supervisor.js") : join(dirname(current), "supervisor.js");
}

function supervisorActive(workspace: string): boolean {
  let descriptor: number;
  try { descriptor = openSync(join(workspace, ".coding-flow", "lock"), constants.O_RDWR | constants.O_NOFOLLOW); }
  catch { return false; }
  try {
    try { flockSync(descriptor, "exnb"); flockSync(descriptor, "un"); return false; }
    catch { return true; }
  } finally { closeSync(descriptor); }
}

function object(value: Json): Record<string, Json> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("HISTORY_MISMATCH");
  return value as Record<string, Json>;
}

async function readArtifactJson(runDirectory: string, artifact: ArtifactRef): Promise<Json> {
  try { return copyJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await verifyArtifact(runDirectory, artifact)))); }
  catch { throw new Error("EVIDENCE_CORRUPT"); }
}

function sum(history: readonly DurableEvent[], field: "commands" | "agentCalls"): number {
  let total = 0;
  for (const event of history) if (event.type === "operation.prepared") {
    const value = object(object(event.data).reservation as Json)[field];
    if (value !== 0 && value !== 1) throw new Error("HISTORY_MISMATCH");
    total += value;
  }
  if (!Number.isSafeInteger(total)) throw new Error("HISTORY_MISMATCH");
  return total;
}

function activeCharge(history: readonly DurableEvent[]): number {
  let total = 0;
  for (const event of history) if (event.type === "time.granted" || event.type === "time.refunded") {
    const value = object(event.data).milliseconds;
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1_000) throw new Error("HISTORY_MISMATCH");
    total += event.type === "time.granted" ? Number(value) : -Number(value);
    if (total < 0) throw new Error("HISTORY_MISMATCH");
  }
  return total;
}

function partialEffects(history: readonly DurableEvent[]): boolean {
  for (const [index, event] of history.entries()) if (event.type === "dispatch.authorized") {
    const preparedHash = object(event.data).preparedHash;
    if (!history.slice(index + 1).some((later) => later.type === "operation.committed"
      && object(later.data).preparedHash === preparedHash)) return true;
  }
  return history.some((event, index) => event.type === "approval.effect-authorized"
    && !history.slice(index + 1).some((later) => later.type === "operation.prepared"));
}

function projectSummary(workspace: string, runId: string, history: readonly DurableEvent[]): RunSummary {
  const created = history[0];
  if (created?.type !== "run.created") throw new Error("HISTORY_MISMATCH");
  const manifest = runManifestSchema.passthrough().parse(created.data);
  const initialized = history.find(({ type }) => type === "run.initialized");
  const savedFlowName = initialized ? object(initialized.data).flowName : null;
  const flowName = typeof savedFlowName === "string" ? savedFlowName : null;
  let attempt = 1;
  for (const event of history) if (event.type === "attempt.started") {
    const next = object(event.data).attempt;
    if (!Number.isSafeInteger(next) || Number(next) !== attempt + 1) throw new Error("HISTORY_MISMATCH");
    attempt = Number(next);
  }
  return {
    version: 2, runId, flowName, entry: manifest.entry, attempt,
    evidenceDirectory: resolve(workspace, ".coding-flow", "runs", runId),
    commands: sum(history, "commands"), agentCalls: sum(history, "agentCalls"),
    activeMsCharged: activeCharge(history), partialEffectsPossible: partialEffects(history),
  };
}

function projectRequest(request: InternalHumanRequest): HumanRequest {
  const presentation = request.evidence[0];
  if (!presentation) throw new Error("HISTORY_MISMATCH");
  const base: HumanRequestBase = {
    requestId: request.id, revision: request.revision,
    title: request.kind === "ask" ? request.question ?? "Question" : request.title ?? (request.kind === "recovery" ? "Recovery required" : "Approval"),
    presentation, presentationHash: request.presentation.hash, expiresAt: request.expiresAt,
  };
  if (request.kind === "ask") {
    if (typeof request.schema !== "object" || request.schema === null || Array.isArray(request.schema)) throw new Error("HISTORY_MISMATCH");
    return { ...base, kind: "question", schema: request.schema as Readonly<Record<string, Json>> };
  }
  if (request.kind === "recovery") {
    if (request.action === undefined || request.boundaryId === undefined || request.attempt === undefined || request.choices === undefined) {
      throw new Error("HISTORY_MISMATCH");
    }
    return {
      ...base, kind: "recovery", boundaryId: request.boundaryId, attempt: request.attempt,
      action: request.action, workspaceHash: request.workspaceHash, choices: request.choices,
    };
  }
  if (request.action === undefined) throw new Error("HISTORY_MISMATCH");
  return { ...base, kind: "approval", action: request.action, workspaceHash: request.workspaceHash };
}

async function projectRunBoundary(workspace: string, runId: string): Promise<RunBoundary> {
  const history = await readVerifiedEvents(workspace, runId);
  const runDirectory = resolve(workspace, ".coding-flow", "runs", runId);
  const base = projectSummary(workspace, runId, history);
  const terminal = history.at(-1);
  if (terminal?.type === "run.succeeded") {
    const data = terminalDataSchema.parse(terminal.data);
    return { ...base, status: "succeeded", output: await readArtifactJson(runDirectory, data.outputArtifact), outputArtifact: data.outputArtifact };
  }
  if (terminal?.type === "run.failed" || terminal?.type === "run.cancelled") {
    const data = errorDataSchema.parse(terminal.data);
    const saved = serializedErrorSchema.parse(await readArtifactJson(runDirectory, data.errorArtifact));
    const error: FlowErrorData = { code: saved.code, message: saved.message };
    return { ...base, status: terminal.type === "run.cancelled" ? "cancelled" : "failed", error };
  }
  const request = await currentHumanRequest(runDirectory, history);
  if (request) return { ...base, status: "waiting-for-human", request: projectRequest(request) };
  const recovery = await inspectRecoveryHistory(runDirectory, history);
  if (recovery && !supervisorActive(workspace)) return {
    ...base, status: "blocked", reason: recovery.reason, message: recovery.message, evidence: recovery.evidence,
  };
  if (supervisorActive(workspace)) return { ...base, status: history.length === 1 ? "starting" : "running" };
  return { ...base, status: "interrupted", lastCommittedSequence: terminal?.sequence ?? 0 };
}

function decimalInteger(value: number): { readonly coefficient: bigint; readonly exponent: number } {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(JSON.stringify(value));
  if (!match) throw new Error("Invalid JSON number");
  const fraction = match[3] ?? "";
  const coefficient = BigInt(`${match[1] ?? ""}${match[2]}${fraction}`);
  return { coefficient, exponent: Number(match[4] ?? 0) - fraction.length };
}

function exactMultiple(value: number, divisor: number): boolean {
  const left = decimalInteger(value);
  const right = decimalInteger(divisor);
  const exponent = left.exponent - right.exponent;
  return exponent >= 0
    ? left.coefficient * (10n ** BigInt(exponent)) % right.coefficient === 0n
    : left.coefficient % (right.coefficient * (10n ** BigInt(-exponent))) === 0n;
}

function validateQuestion(schema: Readonly<Record<string, Json>>, answer: Json): readonly string[] {
  const diagnostics: string[] = [];
  const check = (node: Json, value: Json, path: string): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) { diagnostics.push(`${path}: invalid schema`); return; }
    const contract = node as Record<string, Json>;
    if (Array.isArray(contract.enum)) {
      if (!contract.enum.some((item) => canonicalJson(item) === canonicalJson(value))) diagnostics.push(`${path}: not an offered value`);
      return;
    }
    if (contract.const !== undefined) {
      if (canonicalJson(contract.const) !== canonicalJson(value)) diagnostics.push(`${path}: not the required constant`);
      return;
    }
    if (Array.isArray(contract.anyOf)) {
      const before = diagnostics.length;
      for (const branch of contract.anyOf) {
        check(branch, value, path);
        if (diagnostics.length === before) return;
        diagnostics.length = before;
      }
      diagnostics.push(`${path}: does not match any allowed schema`);
      return;
    }
    if (contract.type === "object") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) { diagnostics.push(`${path}: expected object`); return; }
      const properties = contract.properties;
      if (typeof properties !== "object" || properties === null || Array.isArray(properties)) { diagnostics.push(`${path}: invalid schema`); return; }
      const required = Array.isArray(contract.required) ? contract.required : [];
      const actual = value as Record<string, Json>;
      for (const key of required) if (typeof key === "string" && !(key in actual)) diagnostics.push(`${path}.${key}: required`);
      if (contract.additionalProperties === false) for (const key of Object.keys(actual)) if (!(key in properties)) diagnostics.push(`${path}.${key}: unexpected`);
      for (const [key, child] of Object.entries(properties)) if (key in actual) check(child, actual[key] as Json, `${path}.${key}`);
      return;
    }
    if (contract.type === "array") {
      if (!Array.isArray(value)) { diagnostics.push(`${path}: expected array`); return; }
      if (typeof contract.minItems === "number" && value.length < contract.minItems) diagnostics.push(`${path}: too few items`);
      if (typeof contract.maxItems === "number" && value.length > contract.maxItems) diagnostics.push(`${path}: too many items`);
      for (const [index, item] of value.entries()) check(contract.items as Json, item, `${path}[${String(index)}]`);
      return;
    }
    const valid = contract.type === "string" ? typeof value === "string"
      : contract.type === "boolean" ? typeof value === "boolean"
        : contract.type === "null" ? value === null
        : contract.type === "integer" ? typeof value === "number" && Number.isInteger(value)
          : contract.type === "number" ? typeof value === "number" && Number.isFinite(value) : false;
    if (!valid) { diagnostics.push(`${path}: expected ${String(contract.type)}`); return; }
    if (typeof value === "string") {
      if (typeof contract.minLength === "number" && [...value].length < contract.minLength) diagnostics.push(`${path}: too short`);
      if (typeof contract.maxLength === "number" && [...value].length > contract.maxLength) diagnostics.push(`${path}: too long`);
      if (typeof contract.pattern === "string" && !new RegExp(contract.pattern, "u").test(value)) diagnostics.push(`${path}: pattern mismatch`);
    }
    if (typeof value === "number") {
      if (typeof contract.minimum === "number" && value < contract.minimum) diagnostics.push(`${path}: below minimum`);
      if (typeof contract.maximum === "number" && value > contract.maximum) diagnostics.push(`${path}: above maximum`);
      if (typeof contract.exclusiveMinimum === "number" && value <= contract.exclusiveMinimum) diagnostics.push(`${path}: below exclusive minimum`);
      if (typeof contract.exclusiveMaximum === "number" && value >= contract.exclusiveMaximum) diagnostics.push(`${path}: above exclusive maximum`);
      if (typeof contract.multipleOf === "number" && !exactMultiple(value, contract.multipleOf)) diagnostics.push(`${path}: not a multiple`);
    }
  };
  check(schema as Json, answer, "$answer");
  return diagnostics;
}

async function writeInbox(runDirectory: string, reply: InternalHumanReply): Promise<void> {
  const inbox = resolve(runDirectory, "inbox");
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  const path = resolve(inbox, `${reply.submissionId}.json`);
  const bytes = Buffer.from(`${JSON.stringify({ ...reply, userId: process.getuid?.() ?? 0 })}\n`);
  try {
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await writeAll(file, bytes); await file.sync(); } finally { await file.close(); }
    await syncDirectory(inbox);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    if (!Buffer.from(await readFile(path)).equals(bytes)) throw new Error("HUMAN_SUBMISSION_CONFLICT");
  }
}

async function writeCancellation(runDirectory: string, cancellationId: string, reason: string): Promise<void> {
  const inbox = join(runDirectory, "cancel-inbox");
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  const file = await open(join(inbox, `${cancellationId}.json`), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await writeAll(file, Buffer.from(`${JSON.stringify({ cancellationId, reason })}\n`)); await file.sync(); }
  finally { await file.close(); }
  await syncDirectory(inbox);
}

async function writeRecoveryReply(runDirectory: string, reply: HumanReply): Promise<void> {
  const inbox = join(runDirectory, "recovery-inbox");
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  const path = join(inbox, `${reply.submissionId}.json`);
  const bytes = Buffer.from(`${JSON.stringify({ reply })}\n`);
  try {
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await writeAll(file, bytes); await file.sync(); } finally { await file.close(); }
    await syncDirectory(inbox);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    if (!Buffer.from(await readFile(path)).equals(bytes)) throw new Error("HUMAN_SUBMISSION_CONFLICT");
  }
}

function handle(workspace: string, runId: string): RunHandle {
  const runDirectory = resolve(workspace, ".coding-flow", "runs", runId);
  const readHistory = async (deadline: number): Promise<Awaited<ReturnType<typeof readVerifiedEvents>>> => {
    while (true) {
      try { return await readVerifiedEvents(workspace, runId); }
      catch (error) {
        if (!(error instanceof Error && error.message === "File changed while reading") || Date.now() >= deadline) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
    }
  };
  return {
    runId,
    async wait(timeoutMs = 30_000): Promise<RunBoundary> {
      const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, 30_000));
      let interruptedSequence: number | undefined;
      while (true) {
        try {
          const boundary = await projectRunBoundary(workspace, runId);
          if (boundary.status === "interrupted" && Date.now() < deadline) {
            if (interruptedSequence === boundary.lastCommittedSequence) return boundary;
            interruptedSequence = boundary.lastCommittedSequence;
          } else if (!["starting", "running", "recovering"].includes(boundary.status) || Date.now() >= deadline) return boundary;
        } catch (error) {
          const retryable = error instanceof Error && (("code" in error && error.code === "ENOENT") || error.message === "File changed while reading");
          if (!retryable || Date.now() >= deadline) throw error;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
    },
    async respond(rawReply: HumanReply): Promise<ReplyReceipt> {
      const parsed = publicReplySchema.safeParse(rawReply);
      if (!parsed.success) return {
        submissionId: typeof rawReply?.submissionId === "string" ? rawReply.submissionId : "invalid",
        status: "invalid", diagnostics: parsed.error.issues.map(({ message }) => message),
      };
      const reply = parsed.data;
      const responseDeadline = Date.now() + 5_000;
      const history = await readHistory(responseDeadline);
      const request = await humanRequestById(runDirectory, history, reply.requestId);
      if (!request) return { submissionId: reply.submissionId, status: "invalid", diagnostics: ["Unknown request"] };
      if (request.revision !== reply.revision || request.presentation.hash !== reply.presentationHash) {
        return { submissionId: reply.submissionId, status: "invalid", diagnostics: ["Request revision or presentation is stale"] };
      }
      let internal: InternalHumanReply;
      let retryRecovery = false;
      if (request.kind === "ask") {
        if (typeof request.schema !== "object" || request.schema === null || Array.isArray(request.schema)) throw new Error("HISTORY_MISMATCH");
        const diagnostics = validateQuestion(request.schema as Readonly<Record<string, Json>>, reply.answer);
        if (diagnostics.length) return { submissionId: reply.submissionId, status: "invalid", diagnostics };
        internal = internalHumanReplySchema.parse({ requestId: reply.requestId, submissionId: reply.submissionId, decision: "accept", value: reply.answer });
      } else if (request.kind === "approve") {
        const answer = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string() }).strict().safeParse(reply.answer);
        if (!answer.success) return { submissionId: reply.submissionId, status: "invalid", diagnostics: answer.error.issues.map(({ message }) => message) };
        internal = internalHumanReplySchema.parse({
          requestId: reply.requestId, submissionId: reply.submissionId,
          decision: answer.data.decision === "approve" ? "accept" : "reject", value: answer.data.reason,
        });
      } else {
        const answer = z.object({
          choice: z.enum(["accept-return", "retry-no-application", "abandon"]),
          reason: z.string().min(1), evidencePaths: z.array(z.string()),
        }).strict().safeParse(reply.answer);
        if (!answer.success || !request.choices?.includes(answer.data.choice)
          || (answer.data.choice === "retry-no-application" && answer.data.evidencePaths.length === 0)) {
          return { submissionId: reply.submissionId, status: "invalid", diagnostics: ["Invalid recovery choice or evidence"] };
        }
        retryRecovery = answer.data.choice === "retry-no-application";
        internal = internalHumanReplySchema.parse({
          requestId: reply.requestId, submissionId: reply.submissionId, decision: "accept", value: reply.answer,
        });
      }
      let historical;
      try { historical = await findHistoricalReceipt(runDirectory, history, internal); }
      catch (error) {
        if (error instanceof Error && error.message === "HUMAN_SUBMISSION_CONFLICT") {
          return { submissionId: reply.submissionId, status: "rejected", diagnostics: ["Conflicting reply"] };
        }
        throw error;
      }
      if (historical) {
        if (request.kind !== "recovery" || await recoveryReplyApplied(runDirectory, history, request.id)) {
          return { submissionId: reply.submissionId, status: "already-applied" };
        }
        try { await launchSupervisor({ mode: "recovery", workspace, runId, submissionId: reply.submissionId }); }
        catch (error) {
          return { submissionId: reply.submissionId, status: "invalid", diagnostics: [error instanceof Error ? error.message : String(error)] };
        }
        const completed = await readHistory(responseDeadline);
        return await recoveryReplyApplied(runDirectory, completed, request.id)
          ? { submissionId: reply.submissionId, status: "already-applied" }
          : { submissionId: reply.submissionId, status: "uncertain" };
      }
      const current = await currentHumanRequest(runDirectory, history);
      if (!current || current.id !== reply.requestId) return { submissionId: reply.submissionId, status: "invalid", diagnostics: ["Request is not active"] };
      if (request.kind === "recovery") {
        await writeRecoveryReply(runDirectory, reply);
        try { await launchSupervisor({ mode: "recovery", workspace, runId, submissionId: reply.submissionId }); }
        catch (error) {
          return { submissionId: reply.submissionId, status: "invalid", diagnostics: [error instanceof Error ? error.message : String(error)] };
        }
        if (retryRecovery) {
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            try { await launchSupervisor({ mode: "resume", workspace, runId }); break; }
            catch (error) {
              if (!(error instanceof Error && error.message.includes("WORKSPACE_BUSY"))) break;
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
            }
          }
        }
        return { submissionId: reply.submissionId, status: "accepted" };
      }
      await writeInbox(runDirectory, internal);
      while (Date.now() < responseDeadline) {
        let receipt;
        try { receipt = await findHistoricalReceipt(runDirectory, await readHistory(responseDeadline), internal); }
        catch (error) {
          if (error instanceof Error && error.message === "HUMAN_SUBMISSION_CONFLICT") {
            return { submissionId: reply.submissionId, status: "rejected" };
          }
          throw error;
        }
        if (receipt) return { submissionId: reply.submissionId, status: receipt.status === "accepted" ? "accepted" : "rejected" };
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      return { submissionId: reply.submissionId, status: "uncertain" };
    },
    async cancel(reason = "Cancelled by host"): Promise<RunBoundary> {
      if (Buffer.byteLength(reason, "utf8") > 64 * 1024) throw new Error("Cancellation reason exceeds 64 KiB");
      const boundary = await projectRunBoundary(workspace, runId);
      if (["succeeded", "failed", "cancelled", "timed-out"].includes(boundary.status)) return boundary;
      const cancellationId = randomUUID();
      await writeCancellation(runDirectory, cancellationId, reason);
      if (!supervisorActive(workspace)) await launchSupervisor({ mode: "cancel", workspace, runId, cancellationId, reason });
      const deadline = Date.now() + 5_000;
      let observed = await projectRunBoundary(workspace, runId);
      while (!["succeeded", "failed", "cancelled", "timed-out", "blocked"].includes(observed.status) && Date.now() < deadline) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        observed = await projectRunBoundary(workspace, runId);
      }
      return observed;
    },
  };
}

async function launchSupervisor(request: StartRequest): Promise<RunHandle> {
  const child = fork(supervisorPath(), [], { detached: true, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const runId = await new Promise<string>((resolveRun, reject) => {
    const cleanup = (): void => { child.removeAllListeners(); child.stderr?.removeAllListeners(); child.stderr?.destroy(); child.unref(); };
    child.once("message", (message: unknown) => {
      if (typeof message !== "object" || message === null || !("runId" in message) || typeof message.runId !== "string") {
        cleanup(); reject(new Error("Invalid supervisor handshake")); return;
      }
      cleanup(); resolveRun(message.runId);
    });
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("exit", (code) => { cleanup(); reject(new Error(`Supervisor exited ${String(code)} before startup completed: ${stderr}`)); });
    child.send(request);
  });
  return handle(request.workspace, runId);
}

export async function startFlow(entry: URL, rawInput: unknown, options: RunOptions): Promise<RunHandle> {
  const control = readTestControl(options);
  const workspace = resolve(options.workspace);
  try { await assertContainedPath(workspace, fileURLToPath(entry)); }
  catch (error) { throw new Error("Flow entry is outside workspace", { cause: error }); }
  const request: StartRequest = {
    mode: "start", entry: entry.href, rawInput: copyJson(rawInput), workspace,
    runtime: runtimeSchema.parse(options.runtime),
    allowEdits: options.allowEdits ?? false, limits: { ...(options.limits ?? {}) },
    ...(control?.crashAfterRunCreated === true ? { crashAfterRunCreated: true } : {}),
    ...(control?.crashAt ? { crashAt: control.crashAt } : {}),
    ...(control?.fakeAgentResults ? { fakeAgentResults: control.fakeAgentResults.map(copyJson) } : {}),
  };
  const started = await launchSupervisor(request);
  if (options.signal) {
    if (options.signal.aborted) await started.cancel("Host signal aborted");
    else options.signal.addEventListener("abort", () => { started.cancel("Host signal aborted").catch(() => undefined); }, { once: true });
  }
  return started;
}

export function openRun(workspace: string, runId: string): Promise<RunHandle> & RunHandle {
  assertRunId(runId);
  const opened = handle(resolve(workspace), runId);
  return Object.assign(Promise.resolve(opened), opened);
}

export async function inspectRecovery(workspace: string, runId: string): Promise<RunBoundary> {
  assertRunId(runId);
  return projectRunBoundary(resolve(workspace), runId);
}

export async function resumeRun(workspace: string, runId: string): Promise<RunHandle> {
  assertRunId(runId);
  return launchSupervisor({ mode: "resume", workspace: resolve(workspace), runId });
}

export async function listRuns(workspace: string): Promise<readonly RunBoundary[]> {
  const root = resolve(workspace);
  const directory = resolve(root, ".coding-flow", "runs");
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
  const runs: Array<{ boundary: RunBoundary; timestamp: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    assertRunId(entry.name);
    const path = resolve(directory, entry.name);
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Run directory must not be a symbolic link");
    const history = await readVerifiedEvents(root, entry.name);
    const created = history[0];
    if (!created) throw new Error("HISTORY_MISMATCH");
    runs.push({ boundary: await projectRunBoundary(root, entry.name), timestamp: created.timestamp });
  }
  runs.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.boundary.runId.localeCompare(right.boundary.runId));
  return runs.map(({ boundary }) => boundary);
}
