import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { assertContainedPath, publishBytes, publishJson, publishJsonOrReuse, readBoundedFile, verifyArtifact } from "./artifacts.js";
import { canonicalJson, copyJson, internalHumanReplySchema, type ArtifactRef, type Json } from "./contracts.js";
import { currentHumanRequest, HumanCoordinator, humanRequestById } from "./human.js";
import { type DurableEvent, Journal } from "./journal.js";
import { captureWorkspace } from "./workspace.js";

export type RecoveryChoice = "retry-no-application" | "abandon";

export interface RecoveryState {
  readonly status: "blocked";
  readonly reason: "OUTCOME_UNKNOWN";
  readonly message: string;
  readonly choices: readonly RecoveryChoice[];
  readonly evidence: readonly ArtifactRef[];
}

interface RecoveryAnswer {
  readonly choice: RecoveryChoice;
  readonly reason: string;
  readonly evidencePaths: readonly string[];
}

function object(value: Json): Record<string, Json> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("HISTORY_MISMATCH");
  return value as Record<string, Json>;
}

function recoveryAnswer(value: Json | undefined, choices: readonly string[]): RecoveryAnswer {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Reflect.ownKeys(value).length !== 3 || !("choice" in value) || !("reason" in value) || !("evidencePaths" in value)
    || typeof value.choice !== "string" || !choices.includes(value.choice)
    || typeof value.reason !== "string" || value.reason.length === 0
    || !Array.isArray(value.evidencePaths) || !value.evidencePaths.every((path) => typeof path === "string")
    || (value.choice === "retry-no-application" && value.evidencePaths.length === 0)) {
    throw new Error("INVALID_RECOVERY_REPLY");
  }
  return value as unknown as RecoveryAnswer;
}

function recoveryCompletionExists(history: readonly DurableEvent[], requestId: string, answer: RecoveryAnswer): boolean {
  const decisionIndex = history.findIndex((event) => event.type === "human.reply-decided" && object(event.data).requestId === requestId);
  if (decisionIndex < 0) return false;
  return answer.choice === "retry-no-application"
    ? history.slice(decisionIndex + 1).some((event) => event.type === "recovery.retry-authorized"
      && object(event.data).requestId === requestId)
    : history.slice(decisionIndex + 1).some(({ type }) => type === "run.cancelled");
}

export async function recoveryReplyApplied(
  runDirectory: string,
  history: readonly DurableEvent[],
  requestId: string,
): Promise<boolean> {
  const request = await humanRequestById(runDirectory, history, requestId);
  if (request?.kind !== "recovery" || !request.choices) return false;
  const decision = history.find((event) => event.type === "human.reply-decided" && object(event.data).requestId === requestId);
  if (!decision) return false;
  return recoveryCompletionExists(history, requestId, recoveryAnswer(object(decision.data).value, request.choices));
}

async function existingRecoveryEvidence(
  runDirectory: string,
  submissionId: string,
  count: number,
): Promise<ArtifactRef[]> {
  const evidence: ArtifactRef[] = [];
  for (let index = 0; index < count; index += 1) {
    const path = join(runDirectory, "artifacts", "human", `recovery-${submissionId}-${String(index)}`);
    await assertContainedPath(runDirectory, path);
    if (!(await lstat(path)).isFile()) throw new Error("EVIDENCE_CORRUPT");
    const bytes = await readBoundedFile(path, 64 * 1024 * 1024);
    const artifact = {
      path: relative(runDirectory, path), sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length, mediaType: "application/octet-stream",
    } satisfies ArtifactRef;
    await verifyArtifact(runDirectory, artifact);
    evidence.push(artifact);
  }
  return evidence;
}

async function abandonmentArtifact(runDirectory: string, reason: string): Promise<ArtifactRef> {
  const path = join(runDirectory, "artifacts", "recovery-abandoned.json");
  const expected = Buffer.from(`${canonicalJson({ code: "CANCELLED", message: reason })}\n`);
  try {
    const bytes = await readBoundedFile(path, 1024 * 1024);
    if (!bytes.equals(expected)) throw new Error("EVIDENCE_CORRUPT");
    return {
      path: relative(runDirectory, path), sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length, mediaType: "application/json",
    };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return publishJson(runDirectory, path, { code: "CANCELLED", message: reason });
  }
}

async function completeRecoveryDecision(options: {
  readonly runDirectory: string;
  readonly journal: Journal;
  readonly history: DurableEvent[];
}, request: { readonly id: string; readonly boundaryId: string }, submissionId: string, answer: RecoveryAnswer,
evidence?: readonly ArtifactRef[]): Promise<"retry" | "abandon"> {
  if (recoveryCompletionExists(options.history, request.id, answer)) {
    return answer.choice === "retry-no-application" ? "retry" : "abandon";
  }
  if (answer.choice === "abandon") {
    const errorArtifact = await abandonmentArtifact(options.runDirectory, answer.reason);
    options.history.push(await options.journal.append("run.cancelled", { errorArtifact } as unknown as Json));
    return "abandon";
  }
  const retained = evidence ?? await existingRecoveryEvidence(options.runDirectory, submissionId, answer.evidencePaths.length);
  options.history.push(await options.journal.append("recovery.retry-authorized", {
    requestId: request.id, boundaryId: request.boundaryId, evidence: retained,
  } as unknown as Json));
  return "retry";
}

export async function completePendingRecoveryDecision(options: {
  readonly runDirectory: string;
  readonly workspace: string;
  readonly runId: string;
  readonly journal: Journal;
  readonly history: DurableEvent[];
}): Promise<"retry" | "abandon" | undefined> {
  await HumanCoordinator.validateHistory(options.runDirectory, options.history);
  const requested = [...options.history].reverse().find((event) => event.type === "human.requested" && object(event.data).kind === "recovery");
  if (!requested) return undefined;
  const requestId = String(object(requested.data).requestId);
  const decision = options.history.find((event) => event.type === "human.reply-decided" && object(event.data).requestId === requestId);
  if (!decision) return undefined;
  const request = await humanRequestById(options.runDirectory, options.history, requestId);
  if (request?.kind !== "recovery" || !request.choices || !request.boundaryId) throw new Error("HISTORY_MISMATCH");
  const answer = recoveryAnswer(object(decision.data).value, request.choices);
  if (recoveryCompletionExists(options.history, requestId, answer)) return undefined;
  return completeRecoveryDecision(
    options,
    { id: request.id, boundaryId: request.boundaryId },
    String(object(decision.data).submissionId),
    answer,
  );
}

export async function inspectRecoveryHistory(runDirectory: string, history: readonly DurableEvent[]): Promise<RecoveryState | undefined> {
  await HumanCoordinator.validateHistory(runDirectory, history);
  const terminal = history.some(({ type }) => type === "run.succeeded" || type === "run.failed");
  if (terminal) return undefined;
  const lastIndex = (type: DurableEvent["type"]): number => {
    for (let index = history.length - 1; index >= 0; index -= 1) if (history[index]?.type === type) return index;
    return -1;
  };
  const effectIndex = lastIndex("approval.effect-authorized");
  if (effectIndex >= 0 && !history.slice(effectIndex + 1).some(({ type }) => type === "operation.prepared" || type === "recovery.retry-authorized")) {
    const requestId = String(object(history[effectIndex]!.data).requestId);
    const request = history.find((event) => event.type === "human.requested" && object(event.data).requestId === requestId);
    const evidence = request && Array.isArray(object(request.data).evidence)
      ? object(request.data).evidence as unknown as ArtifactRef[] : [];
    return {
      status: "blocked", reason: "OUTCOME_UNKNOWN",
      message: "The approved effect was durably authorized but no application attempt was prepared.",
      choices: ["retry-no-application", "abandon"], evidence,
    };
  }
  const authorizedIndex = lastIndex("dispatch.authorized");
  if (authorizedIndex >= 0) {
    const preparedHash = String(object(history[authorizedIndex]!.data).preparedHash);
    const committed = history.slice(authorizedIndex + 1).some((event) => event.type === "operation.committed"
      && object(event.data).preparedHash === preparedHash);
    if (!committed) {
      return {
        status: "blocked", reason: "OUTCOME_UNKNOWN",
        message: "The effect may have been applied, but retained evidence cannot prove its outcome.",
        choices: ["abandon"], evidence: [],
      };
    }
  }
  return undefined;
}

export async function commitRecoveryReply(options: {
  readonly runDirectory: string;
  readonly workspace: string;
  readonly runId: string;
  readonly journal: Journal;
  readonly history: DurableEvent[];
  readonly submissionId: string;
}): Promise<"retry" | "abandon"> {
  const pending = await completePendingRecoveryDecision(options);
  if (pending) return pending;
  const request = await currentHumanRequest(options.runDirectory, options.history);
  if (!request || request.kind !== "recovery" || !request.choices || !request.boundaryId) throw new Error("HUMAN_REQUEST_STALE");
  const raw = JSON.parse((await readBoundedFile(
    join(options.runDirectory, "recovery-inbox", `${options.submissionId}.json`), 1024 * 1024,
  )).toString("utf8")) as unknown;
  if (typeof raw !== "object" || raw === null || !("reply" in raw) || typeof raw.reply !== "object" || raw.reply === null) {
    throw new Error("INVALID_RECOVERY_REPLY");
  }
  const reply = raw.reply as Record<string, unknown>;
  if (reply.requestId !== request.id || reply.revision !== request.revision
    || reply.presentationHash !== request.presentation.hash || reply.submissionId !== options.submissionId) {
    throw new Error("HUMAN_REQUEST_STALE");
  }
  const answer = recoveryAnswer(copyJson(reply.answer), request.choices);
  const evidence: ArtifactRef[] = [];
  for (const [index, path] of answer.evidencePaths.entries()) {
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("INVALID_RECOVERY_REPLY");
    }
    const source = resolve(options.workspace, path);
    await assertContainedPath(options.workspace, source);
    if (!(await lstat(source)).isFile()) throw new Error("INVALID_RECOVERY_REPLY");
    evidence.push(await publishBytes(
      options.runDirectory,
      join(options.runDirectory, "artifacts", "human", `recovery-${options.submissionId}-${String(index)}`),
      await readBoundedFile(source, 64 * 1024 * 1024),
      "application/octet-stream",
    ));
  }
  const internal = internalHumanReplySchema.parse({
    requestId: request.id, submissionId: options.submissionId, decision: "accept", value: copyJson(answer),
  });
  const envelope = { ...internal, userId: process.getuid?.() ?? 0 };
  const envelopeArtifact = await publishJson(
    options.runDirectory,
    join(options.runDirectory, "artifacts", "human", `reply-${options.submissionId}.json`),
    envelope as unknown as Json,
  );
  const semanticHash = hash({
    requestId: internal.requestId, decision: internal.decision,
    ...(internal.value === undefined ? {} : { value: internal.value }), userId: envelope.userId,
  });
  options.history.push(await options.journal.append("human.reply-decided", {
    requestId: request.id, submissionId: options.submissionId, semanticHash, status: "accepted",
    value: copyJson(answer), envelopeArtifact,
  } as unknown as Json));
  return completeRecoveryDecision(options, { id: request.id, boundaryId: request.boundaryId }, options.submissionId, answer, evidence);
}

function hash(value: Json): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export async function materializeRecoveryRequest(options: {
  readonly runDirectory: string;
  readonly workspace: string;
  readonly runId: string;
  readonly journal: Journal;
  readonly history: DurableEvent[];
  readonly state: RecoveryState;
  readonly attempt: number;
  readonly afterArtifact?: (stage: "presentation" | "workspace" | "request") => void | Promise<void>;
}): Promise<void> {
  const boundary = [...options.history].reverse().find(({ type }) => type === "dispatch.authorized" || type === "approval.effect-authorized");
  if (!boundary) throw new Error("HISTORY_MISMATCH");
  const boundaryData = object(boundary.data);
  const boundaryId = String(boundaryData.preparedHash ?? boundaryData.requestId);
  const active = await currentHumanRequest(options.runDirectory, options.history);
  if (active?.kind === "recovery" && active.boundaryId === boundaryId && active.attempt === options.attempt) return;
  for (const artifact of options.state.evidence) await verifyArtifact(options.runDirectory, artifact);
  const presentation = copyJson({
    title: "Recovery required",
    markdown: `${options.state.message}\n\nBoundary ${boundaryId}, attempt ${String(options.attempt)}. The old outcome remains unknown. Restoring local files does not prove that remote effects did not occur.`,
  });
  const presentationHash = hash(presentation);
  const presentationArtifact = await publishJsonOrReuse(
    options.runDirectory,
    join(options.runDirectory, "artifacts", "human", `recovery-presentation-${presentationHash}.json`),
    presentation,
  );
  await options.afterArtifact?.("presentation");
  const published = options.history.find((event) => event.type === "presentation.published"
    && object(event.data).presentationId === presentationHash);
  if (!published) {
    const presentationEvent = await options.journal.append("presentation.published", {
      presentationId: presentationHash, presentationHash, artifact: presentationArtifact,
      evidence: [presentationArtifact, ...options.state.evidence],
    } as unknown as Json);
    options.history.push(presentationEvent);
  }
  const workspace = await captureWorkspace(options.workspace);
  const workspaceArtifact = await publishJsonOrReuse(
    options.runDirectory,
    join(options.runDirectory, "artifacts", "human", `recovery-workspace-${presentationHash}.json`),
    workspace as unknown as Json,
  );
  await options.afterArtifact?.("workspace");
  const action = boundary.type === "approval.effect-authorized"
    ? { requestId: String(boundaryData.requestId), effectHash: String(boundaryData.effectHash) }
    : { preparedHash: String(boundaryData.preparedHash), kind: String(boundaryData.kind) };
  const durable = copyJson({
    kind: "recovery", boundaryId, attempt: options.attempt, action,
    workspaceHash: workspace.sha256, choices: options.state.choices,
    presentation: { id: presentationHash, hash: presentationHash },
  });
  const requestId = hash({ runId: options.runId, request: durable });
  const requestHash = hash(durable);
  const attempt = [...options.history].reverse().find((event) => event.type === "attempt.started"
    && object(event.data).attempt === options.attempt);
  const requestedAt = attempt?.timestamp ?? boundary.timestamp;
  const expiresAt = new Date(Date.parse(requestedAt) + 24 * 60 * 60 * 1_000).toISOString();
  const evidence = [presentationArtifact, ...options.state.evidence, workspaceArtifact];
  const record = copyJson({
    id: requestId, kind: "recovery", title: "Recovery required",
    presentation: { id: presentationHash, hash: presentationHash }, action, watch: [],
    boundaryId, attempt: options.attempt, choices: options.state.choices,
    requestedAt, expiresAt, evidence, workspace,
  });
  const requestArtifact = await publishJsonOrReuse(
    options.runDirectory,
    join(options.runDirectory, "artifacts", "human", `request-${requestId}.json`),
    record,
  );
  await options.afterArtifact?.("request");
  options.history.push(await options.journal.append("human.requested", {
    requestId, requestHash, kind: "recovery", requestArtifact, evidence,
    workspaceHash: workspace.sha256, expiresAt,
  } as unknown as Json));
}
