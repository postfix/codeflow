import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { assertContainedPath, publishBytes, publishJson, readBoundedFile, verifyArtifact, writeDurable } from "./artifacts.js";
import { canonicalJson, copyJson, internalHumanReplySchema, type ArtifactRef, type InternalHumanReply, type Json } from "./contracts.js";
import { type DurableEvent, Journal } from "./journal.js";
import { assertWorkspaceFresh, captureWorkspace, type WorkspaceManifest } from "./workspace.js";

const presentationSchema = z.object({
  title: z.string().min(1).max(4_096),
  markdown: z.string().max(1024 * 1024),
  artifacts: z.array(z.object({
    label: z.string().min(1).max(4_096), mediaType: z.string().min(1).max(128),
    source: z.union([
      z.object({ kind: z.literal("workspace"), path: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("artifact"), ref: z.object({
        path: z.string(), sha256: z.string(), bytes: z.number(), mediaType: z.string(),
      }).strict() }).strict(),
    ]),
  }).strict()).max(64).optional(),
}).strict();

const presentedSchema = z.object({ id: z.string().regex(/^[0-9a-f]{64}$/), hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const operationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("present"), trace: z.array(z.json()), presentation: presentationSchema }).strict(),
  z.object({
    kind: z.literal("ask"), trace: z.array(z.json()), question: z.string().min(1).max(64 * 1024),
    presentation: z.union([presentationSchema, presentedSchema]), schema: z.json(), timeoutMs: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal("approve"), trace: z.array(z.json()), title: z.string().min(1).max(64 * 1024),
    presentation: z.union([presentationSchema, presentedSchema]), action: z.json(), watch: z.array(z.string()).max(64),
    timeoutMs: z.number().int().positive(),
  }).strict(),
]);

const requestRecordSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/), kind: z.enum(["ask", "approve", "recovery"]),
  title: z.string().optional(), question: z.string().optional(), presentation: presentedSchema,
  action: z.json().optional(), schema: z.json().optional(), watch: z.array(z.string()),
  watched: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()).optional(),
  boundaryId: z.string().optional(), attempt: z.number().int().positive().optional(),
  choices: z.array(z.enum(["accept-return", "retry-no-application", "abandon"])).optional(),
  requestedAt: z.string(), expiresAt: z.string(), evidence: z.array(z.object({
    path: z.string(), sha256: z.string(), bytes: z.number(), mediaType: z.string(),
  }).strict()), workspace: z.json(),
}).strict();

const envelopeSchema = internalHumanReplySchema.extend({ userId: z.number().int().nonnegative() }).strict();
type InboxEnvelope = z.infer<typeof envelopeSchema>;
type RequestRecord = z.infer<typeof requestRecordSchema>;

const approvalRejections = new WeakMap<Error, { request: string; code: "APPROVAL_DENIED" | "APPROVAL_STALE" }>();
class ApprovalRejection extends Error {
  constructor(readonly code: "APPROVAL_DENIED" | "APPROVAL_STALE") { super(code); }
}

export function approvalRejectionCode(error: unknown, request: Json): "APPROVAL_DENIED" | "APPROVAL_STALE" | undefined {
  const outcome = error instanceof Error ? approvalRejections.get(error) : undefined;
  return outcome?.request === canonicalJson(request) ? outcome.code : undefined;
}

export interface HumanRequest {
  readonly id: string;
  readonly revision: string;
  readonly kind: "ask" | "approve" | "recovery";
  readonly title?: string;
  readonly question?: string;
  readonly presentation: { readonly id: string; readonly hash: string };
  readonly action?: Json;
  readonly schema?: Json;
  readonly boundaryId?: string;
  readonly attempt?: number;
  readonly choices?: readonly ("accept-return" | "retry-no-application" | "abandon")[];
  readonly workspaceHash: string;
  readonly expiresAt: string;
  readonly evidence: readonly ArtifactRef[];
}

export interface ReplyReceipt {
  readonly requestId: string;
  readonly submissionId: string;
  readonly status: "accepted" | "rejected" | "expired" | "stale";
}

export interface HumanCoordinatorOptions {
  readonly runDirectory: string;
  readonly workspace: string;
  readonly runId: string;
  readonly journal: Journal;
  readonly history: readonly DurableEvent[];
  readonly disposablePaths?: readonly string[];
  readonly signal?: AbortSignal;
  readonly crashAt?: "after-human-reply" | "after-approval-gate" | "after-author-delivery" | "after-approval-effect";
}

function hash(value: Json): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function eventData(event: DurableEvent): Record<string, Json> {
  if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) throw new Error("HISTORY_MISMATCH");
  return event.data as Record<string, Json>;
}

function receiptFrom(history: readonly DurableEvent[], event: DurableEvent): ReplyReceipt {
  const data = eventData(event);
  const delivered = history.find((item) => item.type === "author.delivered" && eventData(item).requestId === data.requestId);
  return {
    requestId: String(data.requestId), submissionId: String(data.submissionId),
    status: (delivered ? eventData(delivered).status : data.status) as ReplyReceipt["status"],
  };
}

function semanticHash(envelope: InboxEnvelope): string {
  return hash({ requestId: envelope.requestId, decision: envelope.decision, ...(envelope.value === undefined ? {} : { value: envelope.value }), userId: envelope.userId });
}

function validateEnvelope(raw: unknown): InboxEnvelope {
  const envelope = envelopeSchema.parse(raw);
  if (envelope.userId !== (process.getuid?.() ?? 0)) throw new Error("HUMAN_IDENTITY_MISMATCH");
  return envelope;
}

function applyMessage(history: readonly DurableEvent[], activeRequestId: string, envelope: InboxEnvelope):
  | { readonly kind: "duplicate"; readonly receipt: ReplyReceipt }
  | { readonly kind: "new"; readonly envelope: InboxEnvelope; readonly semanticHash: string } {
  const decisions = history.filter(({ type }) => type === "human.reply-decided");
  const semantic = semanticHash(envelope);
  const sameSubmission = decisions.find((event) => eventData(event).submissionId === envelope.submissionId);
  if (sameSubmission && eventData(sameSubmission).semanticHash !== semantic) throw new Error("HUMAN_SUBMISSION_CONFLICT");
  const duplicate = sameSubmission ?? decisions.find((event) => eventData(event).semanticHash === semantic);
  if (duplicate) return { kind: "duplicate", receipt: receiptFrom(history, duplicate) };
  const requestDecision = decisions.find((event) => eventData(event).requestId === envelope.requestId);
  if (requestDecision) {
    const receipt = receiptFrom(history, requestDecision);
    if (receipt.status === "expired") return { kind: "duplicate", receipt };
    throw new Error("HUMAN_SUBMISSION_CONFLICT");
  }
  if (envelope.requestId !== activeRequestId) throw new Error("HUMAN_REQUEST_STALE");
  return { kind: "new", envelope, semanticHash: semantic };
}

export function applyInboundMessage(history: readonly DurableEvent[], activeRequestId: string, raw: unknown): ReturnType<typeof applyMessage> {
  const envelope = validateEnvelope(raw);
  return applyMessage(history, activeRequestId, envelope);
}

async function readJsonArtifact(runDirectory: string, artifact: ArtifactRef): Promise<Json> {
  try {
    return copyJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await verifyArtifact(runDirectory, artifact))));
  } catch {
    throw new Error("EVIDENCE_CORRUPT");
  }
}

async function writeReceipt(runDirectory: string, submissionId: string, receipt: ReplyReceipt): Promise<void> {
  const directory = join(runDirectory, "receipts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${submissionId}.json`);
  try { await writeDurable(path, Buffer.from(`${canonicalJson(receipt as unknown as Json)}\n`)); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "EEXIST") throw error;
  }
}

export async function findHistoricalReceipt(
  runDirectory: string,
  history: readonly DurableEvent[],
  reply: InternalHumanReply,
): Promise<ReplyReceipt | undefined> {
  await HumanCoordinator.validateHistory(runDirectory, history);
  const envelope = validateEnvelope({ ...reply, userId: process.getuid?.() ?? 0 });
  const applied = applyMessage(history, envelope.requestId, envelope);
  if (applied.kind === "new") return undefined;
  await writeReceipt(runDirectory, envelope.submissionId, applied.receipt);
  return applied.receipt;
}

export async function currentHumanRequest(runDirectory: string, history: readonly DurableEvent[]): Promise<HumanRequest | undefined> {
  await HumanCoordinator.validateHistory(runDirectory, history);
  const lastRequest = [...history].reverse().find(({ type }) => type === "human.requested");
  if (!lastRequest) return undefined;
  const requestId = String(eventData(lastRequest).requestId);
  if (history.some((event) => event.type === "human.reply-decided" && eventData(event).requestId === requestId)) return undefined;
  if (history.some((event) => event.type === "author.delivered" && eventData(event).requestId === requestId)) return undefined;
  return humanRequestFromEvent(runDirectory, lastRequest);
}

async function humanRequestFromEvent(runDirectory: string, event: DurableEvent): Promise<HumanRequest> {
  const artifact = eventData(event).requestArtifact as unknown as ArtifactRef;
  const record = requestRecordSchema.parse(await readJsonArtifact(runDirectory, artifact));
  return {
    id: record.id, revision: String(eventData(event).requestHash), kind: record.kind,
    ...(record.title ? { title: record.title } : {}),
    ...(record.question ? { question: record.question } : {}), presentation: record.presentation,
    ...(record.action === undefined ? {} : { action: record.action }),
    ...(record.schema === undefined ? {} : { schema: record.schema }),
    ...(record.boundaryId === undefined ? {} : { boundaryId: record.boundaryId }),
    ...(record.attempt === undefined ? {} : { attempt: record.attempt }),
    ...(record.choices === undefined ? {} : { choices: record.choices }),
    workspaceHash: String(eventData(event).workspaceHash), expiresAt: record.expiresAt,
    evidence: record.evidence,
  };
}

export async function humanRequestById(
  runDirectory: string,
  history: readonly DurableEvent[],
  requestId: string,
): Promise<HumanRequest | undefined> {
  await HumanCoordinator.validateHistory(runDirectory, history);
  const event = history.find((item) => item.type === "human.requested" && eventData(item).requestId === requestId);
  return event ? humanRequestFromEvent(runDirectory, event) : undefined;
}

export class HumanCoordinator {
  readonly #options: HumanCoordinatorOptions;
  readonly #history: DurableEvent[];

  private constructor(options: HumanCoordinatorOptions) {
    this.#options = options;
    this.#history = [...options.history];
  }

  static async open(options: HumanCoordinatorOptions): Promise<HumanCoordinator> {
    const coordinator = new HumanCoordinator(options);
    await HumanCoordinator.validateHistory(options.runDirectory, options.history);
    await mkdir(join(options.runDirectory, "artifacts", "human"), { recursive: true, mode: 0o700 });
    await mkdir(join(options.runDirectory, "inbox"), { recursive: true, mode: 0o700 });
    await mkdir(join(options.runDirectory, "receipts"), { recursive: true, mode: 0o700 });
    return coordinator;
  }

  static async validateHistory(runDirectory: string, history: readonly DurableEvent[]): Promise<void> {
    const presentations = new Map<string, ArtifactRef>();
    const requests = new Map<string, RequestRecord>();
    const decisions = new Map<string, { readonly status: ReplyReceipt["status"]; readonly submissionId: string }>();
    const submissions = new Set<string>();
    const semantics = new Set<string>();
    const gates = new Map<string, string>();
    const delivered = new Map<string, ReplyReceipt["status"]>();
    const effects = new Set<string>();
    for (const event of history) {
      const data = eventData(event);
      if (event.type === "presentation.published") {
        const artifact = data.artifact as unknown as ArtifactRef;
        const presentation = presentationSchema.parse(await readJsonArtifact(runDirectory, artifact));
        const evidence = data.evidence as unknown as ArtifactRef[];
        for (const item of evidence) await verifyArtifact(runDirectory, item);
        const presentationHash = hash(presentation as unknown as Json);
        const id = String(data.presentationId);
        if (id !== presentationHash || data.presentationHash !== presentationHash || presentations.has(id)
          || canonicalJson(evidence[0] as unknown as Json) !== canonicalJson(artifact as unknown as Json)) throw new Error("HISTORY_MISMATCH");
        presentations.set(id, artifact);
      }
      if (event.type === "human.requested") {
        const record = requestRecordSchema.parse(await readJsonArtifact(
          runDirectory, data.requestArtifact as unknown as ArtifactRef,
        ));
        for (const artifact of data.evidence as unknown as ArtifactRef[]) await verifyArtifact(runDirectory, artifact);
        const workspace = record.workspace as { readonly sha256?: Json };
        if (record.id !== data.requestId || record.kind !== data.kind || record.expiresAt !== data.expiresAt
          || workspace.sha256 !== data.workspaceHash || !presentations.has(record.presentation.id)
          || record.presentation.hash !== record.presentation.id
          || canonicalJson(record.evidence as unknown as Json) !== canonicalJson(data.evidence as Json)
          || requests.has(record.id)) throw new Error("HISTORY_MISMATCH");
        requests.set(record.id, record);
      }
      if (event.type === "human.reply-decided") {
        const envelope = envelopeSchema.parse(await readJsonArtifact(
          runDirectory, data.envelopeArtifact as unknown as ArtifactRef,
        ));
        const requestId = String(data.requestId);
        const status = data.status as ReplyReceipt["status"];
        if (!requests.has(requestId) || envelope.requestId !== requestId || envelope.submissionId !== data.submissionId
          || semanticHash(envelope) !== data.semanticHash || submissions.has(envelope.submissionId)
          || semantics.has(String(data.semanticHash)) || decisions.has(requestId)
          || (status === "accepted" && envelope.decision !== "accept")
          || (status === "rejected" && envelope.decision !== "reject")) throw new Error("HISTORY_MISMATCH");
        submissions.add(envelope.submissionId);
        semantics.add(String(data.semanticHash));
        decisions.set(requestId, { status, submissionId: envelope.submissionId });
      }
      if (event.type === "approval.gate-opened" || event.type === "approval.gate-denied" || event.type === "approval.gate-stale") {
        const requestId = String(data.requestId);
        const request = requests.get(requestId);
        const decision = decisions.get(requestId);
        const workspace = request?.workspace as { readonly sha256?: Json } | undefined;
        const expected = event.type === "approval.gate-denied" ? "rejected" : "accepted";
        if (request?.kind !== "approve" || decision?.status !== expected || decision.submissionId !== data.submissionId
          || workspace?.sha256 !== data.workspaceHash || gates.has(requestId)) throw new Error("HISTORY_MISMATCH");
        gates.set(requestId, event.type);
      }
      if (event.type === "author.delivered") {
        const requestId = String(data.requestId);
        const status = data.status as ReplyReceipt["status"];
        const request = requests.get(requestId);
        const decision = decisions.get(requestId);
        if (!request || !decision || delivered.has(requestId)
          || (data.error !== undefined && (data.error !== "WORKSPACE_CHANGED" || status !== "stale" || request.kind !== "approve" || decision.status !== "accepted" || gates.has(requestId)))
          || (status !== decision.status && !(decision.status === "accepted" && status === "stale"))
          || (request.kind === "approve" && status === "accepted" && gates.get(requestId) !== "approval.gate-opened")
          || (request.kind === "approve" && status === "rejected" && gates.get(requestId) !== "approval.gate-denied")
          || (request.kind === "approve" && status === "stale" && data.error !== "WORKSPACE_CHANGED" && gates.get(requestId) !== "approval.gate-stale")) throw new Error("HISTORY_MISMATCH");
        delivered.set(requestId, status);
      }
      if (event.type === "approval.effect-authorized") {
        const requestId = String(data.requestId);
        if (gates.get(requestId) !== "approval.gate-opened" || delivered.get(requestId) !== "accepted" || effects.has(requestId)) throw new Error("HISTORY_MISMATCH");
        effects.add(requestId);
      }
    }
  }

  async #append(type: Parameters<Journal["append"]>[0], data: Json): Promise<DurableEvent> {
    const event = await this.#options.journal.append(type, data);
    this.#history.push(event);
    return event;
  }

  #crash(point: HumanCoordinatorOptions["crashAt"]): void {
    if (this.#options.crashAt === point) process.exit(92);
  }

  async #presentation(value: Json): Promise<{ readonly presented: { readonly id: string; readonly hash: string }; readonly evidence: ArtifactRef[] }> {
    const parsed = presentationSchema.parse(value);
    const presentationHash = hash(parsed as unknown as Json);
    const existing = this.#history.find((event) => event.type === "presentation.published" && eventData(event).presentationId === presentationHash);
    let evidence: ArtifactRef[] = [];
    if (existing) {
      const artifact = eventData(existing).artifact as unknown as ArtifactRef;
      await verifyArtifact(this.#options.runDirectory, artifact);
      evidence = eventData(existing).evidence as unknown as ArtifactRef[];
      for (const item of evidence) await verifyArtifact(this.#options.runDirectory, item);
      return { presented: { id: presentationHash, hash: presentationHash }, evidence };
    } else {
      const artifact = await publishJson(
        this.#options.runDirectory,
        join(this.#options.runDirectory, "artifacts", "human", `presentation-${presentationHash}.json`),
        parsed as unknown as Json,
      );
      evidence.push(artifact);
    }
    for (const [index, item] of (parsed.artifacts ?? []).entries()) {
      if (item.source.kind === "artifact") {
        await verifyArtifact(this.#options.runDirectory, item.source.ref);
        evidence.push(item.source.ref);
        continue;
      }
      const source = resolve(this.#options.workspace, item.source.path);
      await assertContainedPath(this.#options.workspace, source);
      const bytes = await readBoundedFile(source, 64 * 1024 * 1024);
      const snapshot = await publishBytes(
        this.#options.runDirectory,
        join(this.#options.runDirectory, "artifacts", "human", `presentation-${presentationHash}-${String(index)}`),
        bytes,
        item.mediaType,
      );
      evidence.push(snapshot);
    }
    await this.#append("presentation.published", {
      presentationId: presentationHash, presentationHash, artifact: evidence[0]!, evidence,
    } as unknown as Json);
    return { presented: { id: presentationHash, hash: presentationHash }, evidence };
  }

  async #resolvePresentation(value: Json): Promise<{ readonly presented: { readonly id: string; readonly hash: string }; readonly evidence: ArtifactRef[] }> {
    const presented = presentedSchema.safeParse(value);
    if (!presented.success) return this.#presentation(value);
    const event = this.#history.find((item) => item.type === "presentation.published" && eventData(item).presentationId === presented.data.id);
    if (!event || presented.data.hash !== eventData(event).presentationHash) throw new Error("PRESENTATION_UNAVAILABLE");
    const artifact = eventData(event).artifact as unknown as ArtifactRef;
    await verifyArtifact(this.#options.runDirectory, artifact);
    const evidence = eventData(event).evidence as unknown as ArtifactRef[];
    for (const item of evidence) await verifyArtifact(this.#options.runDirectory, item);
    return { presented: presented.data, evidence };
  }

  async perform(raw: Json): Promise<Json> {
    const operation = operationSchema.parse(raw);
    if (operation.kind === "present") return (await this.#presentation(operation.presentation as unknown as Json)).presented;
    const presentation = await this.#resolvePresentation(operation.presentation as unknown as Json);
    const durable = copyJson({
      kind: operation.kind, trace: operation.trace, presentation: presentation.presented,
      ...(operation.kind === "ask" ? { question: operation.question, schema: operation.schema }
        : { title: operation.title, action: operation.action, watch: operation.watch }),
    });
    const requestId = hash({ runId: this.#options.runId, request: durable });
    const requestHash = hash(durable);
    const existing = this.#history.find((event) => event.type === "human.requested" && eventData(event).requestId === requestId);
    let record: RequestRecord;
    if (existing) {
      if (eventData(existing).requestHash !== requestHash) throw new Error("HISTORY_MISMATCH");
      record = requestRecordSchema.parse(await readJsonArtifact(this.#options.runDirectory, eventData(existing).requestArtifact as unknown as ArtifactRef));
    } else {
      const lastRequest = [...this.#history].reverse().find(({ type }) => type === "human.requested");
      const lastRequestData = lastRequest && eventData(lastRequest);
      const delivered = lastRequestData && this.#history.some((event) => event.type === "author.delivered"
        && eventData(event).requestId === lastRequestData.requestId);
      const recovered = lastRequestData?.kind === "recovery" && this.#history.some((event) => event.type === "recovery.retry-authorized"
        && eventData(event).requestId === lastRequestData.requestId);
      if (lastRequest && !delivered && !recovered) {
        throw new Error("HUMAN_REQUEST_ACTIVE");
      }
      const workspace = await captureWorkspace(this.#options.workspace, {
        ...(this.#options.disposablePaths ? { disposablePaths: this.#options.disposablePaths } : {}),
      });
      const requestedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + operation.timeoutMs).toISOString();
      const workspaceArtifact = await publishJson(
        this.#options.runDirectory,
        join(this.#options.runDirectory, "artifacts", "human", `workspace-${requestId}.json`),
        workspace as unknown as Json,
      );
      const evidence = [...presentation.evidence, workspaceArtifact];
      const watched = [];
      if (operation.kind === "approve") for (const path of operation.watch) {
        const source = resolve(this.#options.workspace, path);
        await assertContainedPath(this.#options.workspace, source);
        watched.push({ path, sha256: createHash("sha256").update(await readBoundedFile(source, 64 * 1024 * 1024)).digest("hex") });
      }
      record = requestRecordSchema.parse({
        id: requestId, kind: operation.kind,
        ...(operation.kind === "ask" ? { question: operation.question, schema: operation.schema }
          : { title: operation.title, action: operation.action }),
        presentation: presentation.presented, watch: operation.kind === "approve" ? operation.watch : [],
        requestedAt, expiresAt, evidence, workspace, watched,
      });
      const requestArtifact = await publishJson(
        this.#options.runDirectory,
        join(this.#options.runDirectory, "artifacts", "human", `request-${requestId}.json`),
        record as unknown as Json,
      );
      await this.#append("human.requested", {
        requestId, requestHash, kind: operation.kind, requestArtifact, evidence,
        workspaceHash: workspace.sha256, expiresAt,
      } as unknown as Json);
    }
    try { return await this.#awaitDecision(record); }
    catch (error) {
      if (error instanceof ApprovalRejection) approvalRejections.set(error, { request: canonicalJson(raw), code: error.code });
      throw error;
    }
  }

  async #awaitDecision(record: RequestRecord): Promise<Json> {
    let decision = this.#history.find((event) => event.type === "human.reply-decided" && eventData(event).requestId === record.id);
    if (!decision) {
      while (!decision) {
        if (this.#options.signal?.aborted) throw new Error("CANCELLED");
        if (Date.now() > Date.parse(record.expiresAt)) {
          const envelope = { requestId: record.id, submissionId: `expired-${record.id.slice(0, 16)}`, decision: "reject" as const, userId: process.getuid?.() ?? 0 };
          decision = await this.#commitDecision(record, envelope, "expired");
          break;
        }
        for (const name of (await readdir(join(this.#options.runDirectory, "inbox"))).sort()) {
          const raw = JSON.parse((await readBoundedFile(join(this.#options.runDirectory, "inbox", name), 1024 * 1024)).toString("utf8"));
          let applied: ReturnType<typeof applyInboundMessage>;
          try { applied = applyInboundMessage(this.#history, record.id, raw); }
          catch { continue; }
          if (applied.kind === "duplicate") {
            await writeReceipt(this.#options.runDirectory, envelopeSchema.parse(raw).submissionId, applied.receipt);
            continue;
          }
          const status = applied.envelope.decision === "reject" ? "rejected" : "accepted";
          decision = await this.#commitDecision(record, applied.envelope, status, applied.semanticHash);
          break;
        }
        if (!decision) await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
    }
    const data = eventData(decision);
    const delivered = this.#history.find((event) => event.type === "author.delivered" && eventData(event).requestId === record.id);
    let status = (delivered ? eventData(delivered).status : data.status) as ReplyReceipt["status"];
    let blockingError = delivered ? eventData(delivered).error : undefined;
    if (!delivered) {
      if (record.kind === "approve" && status === "accepted") {
        try { await assertWorkspaceFresh(record.workspace as unknown as WorkspaceManifest); }
        catch (error) {
          if (!(error instanceof Error) || error.message !== "Workspace is stale") throw error;
          status = "stale";
          blockingError = "WORKSPACE_CHANGED";
        }
        if (status === "accepted" && !(await this.#presentationFresh(record))) status = "stale";
      }
      if (record.kind === "approve" && status !== "expired" && !blockingError) {
        const gateType = status === "accepted" ? "approval.gate-opened" : status === "rejected" ? "approval.gate-denied" : "approval.gate-stale";
        const gates = this.#history.filter((event) => event.type.startsWith("approval.gate-") && eventData(event).requestId === record.id);
        if (gates.length > 1 || (gates[0] && gates[0].type !== gateType)) throw new Error("HISTORY_MISMATCH");
        if (!gates.length) {
          await this.#append(gateType, {
            requestId: record.id, submissionId: String(data.submissionId), workspaceHash: (record.workspace as { sha256: string }).sha256,
          } as unknown as Json);
          this.#crash("after-approval-gate");
        }
      }
      await this.#append("author.delivered", { requestId: record.id, status, ...(blockingError ? { error: blockingError } : {}) } as unknown as Json);
      await writeReceipt(this.#options.runDirectory, String(data.submissionId), {
        requestId: record.id, submissionId: String(data.submissionId), status,
      });
      this.#crash("after-author-delivery");
    }
    await writeReceipt(this.#options.runDirectory, String(data.submissionId), {
      requestId: record.id, submissionId: String(data.submissionId), status,
    });
    if (blockingError) throw new Error(String(blockingError));
    if (status === "expired") throw new Error("HUMAN_TIMEOUT");
    if (record.kind === "approve" && (status === "rejected" || status === "stale")) {
      throw new ApprovalRejection(status === "rejected" ? "APPROVAL_DENIED" : "APPROVAL_STALE");
    }
    if (status !== "accepted") throw new Error(`HUMAN_${status.toUpperCase()}`);
    return record.kind === "approve"
      ? { requestId: record.id, action: record.action as Json }
      : (data.value ?? null);
  }

  async #presentationFresh(record: RequestRecord): Promise<boolean> {
    for (const item of record.watched ?? []) {
      const source = resolve(this.#options.workspace, item.path);
      await assertContainedPath(this.#options.workspace, source);
      if (createHash("sha256").update(await readBoundedFile(source, 64 * 1024 * 1024)).digest("hex") !== item.sha256) return false;
    }
    const published = this.#history.find((event) => event.type === "presentation.published" && eventData(event).presentationId === record.presentation.id);
    if (!published) throw new Error("HISTORY_MISMATCH");
    const data = eventData(published);
    const presentation = presentationSchema.parse(await readJsonArtifact(this.#options.runDirectory, data.artifact as unknown as ArtifactRef));
    const evidence = data.evidence as unknown as ArtifactRef[];
    for (const [index, item] of (presentation.artifacts ?? []).entries()) {
      if (item.source.kind !== "workspace") continue;
      const source = resolve(this.#options.workspace, item.source.path);
      await assertContainedPath(this.#options.workspace, source);
      const current = await readBoundedFile(source, 64 * 1024 * 1024);
      if (createHash("sha256").update(current).digest("hex") !== evidence[index + 1]?.sha256) return false;
    }
    return true;
  }

  async #commitDecision(
    record: RequestRecord,
    envelope: InboxEnvelope,
    status: ReplyReceipt["status"],
    semantic = semanticHash(envelope),
  ): Promise<DurableEvent> {
    const envelopeArtifact = await publishJson(
      this.#options.runDirectory,
      join(this.#options.runDirectory, "artifacts", "human", `reply-${envelope.submissionId}.json`),
      envelope as unknown as Json,
    );
    const event = await this.#append("human.reply-decided", {
      requestId: record.id, submissionId: envelope.submissionId, semanticHash: semantic, status,
      ...(envelope.value === undefined ? {} : { value: envelope.value }), envelopeArtifact,
    } as unknown as Json);
    this.#crash("after-human-reply");
    return event;
  }

  async authorizeEffect(requestId: string, effect: Json): Promise<void> {
    const effectHash = hash(effect);
    const existingIndex = this.#history.findIndex((event) => event.type === "approval.effect-authorized" && eventData(event).requestId === requestId);
    if (existingIndex >= 0) {
      if (eventData(this.#history[existingIndex]!).effectHash !== effectHash) throw new Error("APPROVAL_SCOPE_MISMATCH");
      if (!this.#history.slice(existingIndex + 1).some(({ type }) => type === "operation.prepared" || type === "recovery.retry-authorized")) {
        throw new Error("APPROVED_EFFECT_UNKNOWN");
      }
      return;
    }
    const requestEvent = this.#history.find((event) => event.type === "human.requested" && eventData(event).requestId === requestId);
    if (!requestEvent) throw new Error("APPROVAL_NOT_OPEN");
    const request = requestRecordSchema.parse(await readJsonArtifact(
      this.#options.runDirectory, eventData(requestEvent).requestArtifact as unknown as ArtifactRef,
    ));
    try { await assertWorkspaceFresh(request.workspace as unknown as WorkspaceManifest); }
    catch (error) {
      if (error instanceof Error && error.message === "Workspace is stale") throw new Error("WORKSPACE_CHANGED", { cause: error });
      throw error;
    }
    await this.#append("approval.effect-authorized", { requestId, effectHash } as unknown as Json);
    this.#crash("after-approval-effect");
  }

  history(): readonly DurableEvent[] { return this.#history; }
}

function requireCommittedApprovalGateOpened(coordinator: HumanCoordinator, requestId: string): void {
  const history = coordinator.history();
  const gate = history.find((event) => event.type === "approval.gate-opened" && eventData(event).requestId === requestId);
  const delivered = history.find((event) => event.type === "author.delivered" && eventData(event).requestId === requestId
    && eventData(event).status === "accepted");
  if (!gate || !delivered) throw new Error("APPROVAL_NOT_OPEN");
}

async function authorizeApprovedEffect<T>(coordinator: HumanCoordinator, requestId: string, effect: Json, dispatch: () => Promise<T>): Promise<T> {
  await coordinator.authorizeEffect(requestId, effect);
  return dispatch();
}

export async function dispatchApprovedEffect<T>(
  coordinator: HumanCoordinator,
  requestId: string,
  effect: Json,
  dispatch: () => Promise<T>,
): Promise<T> {
  requireCommittedApprovalGateOpened(coordinator, requestId);
  return authorizeApprovedEffect(coordinator, requestId, effect, dispatch);
}
