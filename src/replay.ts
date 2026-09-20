import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { publishJson, verifyArtifact, writeDurable } from "./artifacts.js";
import { artifactRefSchema, canonicalJson, copyJsonWithLimit, MAX_ARTIFACT_BYTES, MAX_JSON_BYTES, type ArtifactRef, type Json } from "./contracts.js";
import { type DurableEvent, Journal } from "./journal.js";
import { assertWorkspaceFresh, captureWorkspace, type WorkspaceManifest } from "./workspace.js";

const workspaceSchema = z.object({
  version: z.literal(1), root: z.string().min(1),
  files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), mode: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()),
  directories: z.array(z.object({ path: z.string(), mode: z.number().int().nonnegative() }).strict()),
  totalBytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  policy: z.object({ disposablePaths: z.array(z.string()), maxFiles: z.number().int().positive(), maxBytes: z.number().int().positive(), maxFileBytes: z.number().int().positive() }).strict(),
}).strict();
const limitsSchema = z.object({ maxCommands: z.number().int().nonnegative(), maxAgentCalls: z.number().int().nonnegative() }).strict();
const capturedSchema = z.object({ manifestArtifact: artifactRefSchema, limits: limitsSchema }).strict();
const preparedSchema = z.object({
  ordinal: z.number().int().positive(), scope: z.literal("root"), kind: z.enum(["command", "agent", "read"]), request: z.json(),
  requestArtifact: artifactRefSchema.optional(),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/), preWorkspaceHash: z.string().regex(/^[0-9a-f]{64}$/),
  reservation: z.object({ commands: z.union([z.literal(0), z.literal(1)]), agentCalls: z.union([z.literal(0), z.literal(1)]) }).strict(),
}).strict();
const authorizedSchema = z.object({ preparedHash: z.string().regex(/^[0-9a-f]{64}$/), ordinal: z.number().int().positive(), kind: z.enum(["command", "agent", "read"]) }).strict();
const committedSchema = z.object({
  preparedHash: z.string().regex(/^[0-9a-f]{64}$/), outcome: z.json(), postWorkspaceArtifact: artifactRefSchema,
  outcomeArtifact: artifactRefSchema.optional(),
  counters: z.object({ commands: z.number().int().nonnegative(), agentCalls: z.number().int().nonnegative() }).strict(),
}).strict();

type Limits = z.infer<typeof limitsSchema>;
type Prepared = z.infer<typeof preparedSchema>;
type Committed = z.infer<typeof committedSchema>;
type OperationKind = Prepared["kind"];
export interface PreparedOperationBinding {
  readonly ordinal: number;
  readonly preparedHash: string;
  readonly kind: OperationKind;
}
interface Entry { readonly prepared: Prepared; readonly preparedHash: string; readonly authorized: boolean; readonly committed?: Committed; readonly postWorkspace?: WorkspaceManifest }

type Settlement<T extends Json> =
  | { readonly status: "resolved"; readonly value: T }
  | { readonly status: "rejected"; readonly error: { readonly code: string; readonly message: string } };

export class CommittedRejection extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ReplayOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly journal: Journal;
  readonly history: readonly DurableEvent[];
  readonly limits: Limits;
}

function hash(value: Json): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function isJsonObject(value: Json): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readWorkspace(runDirectory: string, artifact: ArtifactRef): Promise<WorkspaceManifest> {
  try {
    const bytes = await verifyArtifact(runDirectory, artifact);
    return workspaceSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) as WorkspaceManifest;
  } catch {
    throw new Error("EVIDENCE_CORRUPT");
  }
}

async function publishWorkspace(runDirectory: string, name: string, workspace: WorkspaceManifest): Promise<ArtifactRef> {
  return publishJson(runDirectory, join(runDirectory, "artifacts", name), workspace as unknown as Json);
}

async function publishValue(runDirectory: string, name: string, value: Json): Promise<ArtifactRef> {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error("Request exceeds artifact limit");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = join(runDirectory, "artifacts", `${name}-${sha256}.json`);
  await writeDurable(path, bytes);
  return { path: `artifacts/${name}-${sha256}.json`, sha256, bytes: bytes.length, mediaType: "application/json" };
}

async function readValue(runDirectory: string, artifact: ArtifactRef): Promise<Json> {
  try {
    const bytes = await verifyArtifact(runDirectory, artifact);
    return copyJsonWithLimit(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), MAX_ARTIFACT_BYTES);
  } catch {
    throw new Error("EVIDENCE_CORRUPT");
  }
}

async function publishOrReuseInitialWorkspace(runDirectory: string, workspace: WorkspaceManifest): Promise<ArtifactRef> {
  try {
    return await publishWorkspace(runDirectory, "workspace-initial.json", workspace);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Artifact already exists") throw error;
    const bytes = Buffer.from(`${canonicalJson(workspace as unknown as Json)}\n`, "utf8");
    const artifact: ArtifactRef = {
      path: "artifacts/workspace-initial.json",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      mediaType: "application/json",
    };
    try {
      await verifyArtifact(runDirectory, artifact);
    } catch (verificationError) {
      throw new Error("EVIDENCE_CORRUPT", { cause: verificationError });
    }
    return artifact;
  }
}

async function assertFresh(workspace: WorkspaceManifest): Promise<void> {
  await assertWorkspaceFresh(workspace);
}

function reserveLimits(entries: readonly Entry[], kind: OperationKind, limits: Limits): Prepared["reservation"] {
  const commands = entries.filter(({ prepared }) => prepared.reservation.commands === 1).length;
  const agentCalls = entries.filter(({ prepared }) => prepared.reservation.agentCalls === 1).length;
  if ((kind === "command" && commands >= limits.maxCommands) || (kind === "agent" && agentCalls >= limits.maxAgentCalls)) throw new Error("LIMIT_EXCEEDED");
  return kind === "command" ? { commands: 1, agentCalls: 0 }
    : kind === "agent" ? { commands: 0, agentCalls: 1 }
      : { commands: 0, agentCalls: 0 };
}

async function prepareAttempt(journal: Journal, draft: Omit<Prepared, "reservation">, reservation: Prepared["reservation"]): Promise<DurableEvent> {
  return journal.append("operation.prepared", { ...draft, reservation } as unknown as Json);
}

async function admitExternalOperation(
  journal: Journal,
  entries: readonly Entry[],
  baseline: WorkspaceManifest,
  kind: OperationKind,
  limits: Limits,
  draft: Omit<Prepared, "reservation">,
  canPrepare: () => boolean,
  prepare: () => Promise<void>,
): Promise<DurableEvent> {
  await assertFresh(baseline);
  const reservation = reserveLimits(entries, kind, limits);
  if (!canPrepare()) throw new Error("COMMAND_CLOSED");
  await assertFresh(baseline);
  await prepare();
  return prepareAttempt(journal, draft, reservation);
}

export async function captureInitialWorkspace(
  runDirectory: string,
  journal: Journal,
  workspace: string,
  limits: Limits,
  disposablePaths: readonly string[] = [],
): Promise<DurableEvent> {
  const captured = await captureWorkspace(workspace, { disposablePaths });
  const manifestArtifact = await publishOrReuseInitialWorkspace(runDirectory, captured);
  return journal.append("workspace.captured", { manifestArtifact, limits } as unknown as Json);
}

export class ReplayFrontier {
  readonly #options: ReplayOptions;
  readonly #entries: Entry[];
  #cursor = 0;
  #baseline: WorkspaceManifest;

  private constructor(options: ReplayOptions, entries: Entry[], baseline: WorkspaceManifest) {
    this.#options = options;
    this.#entries = entries;
    this.#baseline = baseline;
  }

  static async open(options: ReplayOptions): Promise<ReplayFrontier> {
    if (options.history.length === 0 || options.history.some(({ runId }) => runId !== options.runId)) throw new Error("HISTORY_MISMATCH");
    const capturedEvents = options.history.filter(({ type }) => type === "workspace.captured");
    if (capturedEvents.length !== 1) throw new Error("HISTORY_MISMATCH");
    const captured = capturedSchema.safeParse(capturedEvents[0]!.data);
    if (!captured.success || canonicalJson(captured.data.limits as unknown as Json) !== canonicalJson(options.limits as unknown as Json)) throw new Error("HISTORY_MISMATCH");
    let baseline = await readWorkspace(options.runDirectory, captured.data.manifestArtifact);
    const entries: Entry[] = [];
    for (const event of options.history) {
      if (event.type === "operation.prepared") {
        const parsed = preparedSchema.safeParse(event.data);
        if (!parsed.success || (parsed.data.requestArtifact !== undefined && parsed.data.request !== null)) throw new Error("HISTORY_MISMATCH");
        const request = preparedSchema.shape.request.parse(
          parsed.data.requestArtifact ? await readValue(options.runDirectory, parsed.data.requestArtifact) : parsed.data.request,
        );
        const prepared: Prepared = { ...parsed.data, request };
        if (prepared.ordinal !== entries.length + 1 || prepared.requestHash !== hash(prepared.request)
          || prepared.preWorkspaceHash !== baseline.sha256 || (entries.length > 0 && !entries.at(-1)?.committed)) throw new Error("HISTORY_MISMATCH");
        const expectedReservation = prepared.kind === "command" ? { commands: 1, agentCalls: 0 }
          : prepared.kind === "agent" ? { commands: 0, agentCalls: 1 }
            : { commands: 0, agentCalls: 0 };
        if (canonicalJson(prepared.reservation as unknown as Json) !== canonicalJson(expectedReservation as unknown as Json)) {
          throw new Error("HISTORY_MISMATCH");
        }
        entries.push({ prepared, preparedHash: event.hash, authorized: false });
        const commands = entries.filter(({ prepared: item }) => item.reservation.commands === 1).length;
        const agentCalls = entries.filter(({ prepared: item }) => item.reservation.agentCalls === 1).length;
        if (commands > options.limits.maxCommands || agentCalls > options.limits.maxAgentCalls) throw new Error("HISTORY_MISMATCH");
      } else if (event.type === "dispatch.authorized") {
        const authorized = authorizedSchema.safeParse(event.data);
        const current = entries.at(-1);
        if (!authorized.success || !current || current.authorized || current.committed || authorized.data.preparedHash !== current.preparedHash
          || authorized.data.ordinal !== current.prepared.ordinal || authorized.data.kind !== current.prepared.kind) throw new Error("HISTORY_MISMATCH");
        entries[entries.length - 1] = { ...current, authorized: true };
      } else if (event.type === "operation.committed") {
        const parsed = committedSchema.safeParse(event.data);
        const current = entries.at(-1);
        if (!parsed.success || !current?.authorized || current.committed || parsed.data.preparedHash !== current.preparedHash
          || (parsed.data.outcomeArtifact !== undefined && parsed.data.outcome !== null)) throw new Error("HISTORY_MISMATCH");
        const outcome = committedSchema.shape.outcome.parse(
          parsed.data.outcomeArtifact ? await readValue(options.runDirectory, parsed.data.outcomeArtifact) : parsed.data.outcome,
        );
        const committed: Committed = { ...parsed.data, outcome };
        const postWorkspace = await readWorkspace(options.runDirectory, committed.postWorkspaceArtifact);
        const commands = entries.filter(({ prepared }) => prepared.reservation.commands === 1).length;
        const agentCalls = entries.filter(({ prepared }) => prepared.reservation.agentCalls === 1).length;
        if (postWorkspace.root !== baseline.root || committed.counters.commands !== commands || committed.counters.agentCalls !== agentCalls) throw new Error("HISTORY_MISMATCH");
        entries[entries.length - 1] = { ...current, committed, postWorkspace };
        baseline = postWorkspace;
      }
    }
    return new ReplayFrontier(options, entries, baseline);
  }

  async perform<T extends Json>(
    kind: OperationKind,
    request: Json,
    dispatch: () => Promise<T>,
    canPrepare = () => true,
    prepare: () => Promise<void> = async () => undefined,
    afterPrepared: (binding: PreparedOperationBinding) => Promise<void> = async () => undefined,
  ): Promise<T> {
    const copiedRequest = copyJsonWithLimit(request, MAX_ARTIFACT_BYTES);
    const durableRequest = JSON.parse(canonicalJson(copiedRequest));
    const existing = this.#entries[this.#cursor];
    if (existing?.committed && existing.postWorkspace) {
      this.#match(existing, kind, copiedRequest);
      await assertFresh(existing.postWorkspace);
      this.#cursor += 1;
      this.#baseline = existing.postWorkspace;
      return this.#deliver(existing.committed.outcome, kind) as T;
    }
    if (existing) {
      this.#match(existing, kind, copiedRequest);
      if (existing.authorized) throw new Error("OUTCOME_UNKNOWN");
      await assertFresh(this.#baseline);
      if (!canPrepare()) throw new Error("COMMAND_CLOSED");
      await assertFresh(this.#baseline);
      await prepare();
      await afterPrepared({ ordinal: existing.prepared.ordinal, preparedHash: existing.preparedHash, kind });
      return this.#finish(existing, dispatch);
    }

    const ordinal = this.#entries.length + 1;
    const requestArtifact = await publishValue(this.#options.runDirectory, `request-${ordinal}`, durableRequest);
    const preparedEvent = await admitExternalOperation(this.#options.journal, this.#entries, this.#baseline, kind, this.#options.limits, {
      ordinal, scope: "root", kind, request: null, requestArtifact, requestHash: hash(copiedRequest), preWorkspaceHash: this.#baseline.sha256,
    }, canPrepare, prepare);
    const entry: Entry = {
      prepared: { ...preparedSchema.parse(preparedEvent.data), request: durableRequest },
      preparedHash: preparedEvent.hash,
      authorized: false,
    };
    this.#entries.push(entry);
    await afterPrepared({ ordinal, preparedHash: entry.preparedHash, kind });
    return this.#finish(entry, dispatch);
  }

  async #authorize(entry: Entry): Promise<void> {
    await this.#options.journal.append("dispatch.authorized", {
      preparedHash: entry.preparedHash, ordinal: entry.prepared.ordinal, kind: entry.prepared.kind,
    } as unknown as Json);
    this.#entries[entry.prepared.ordinal - 1] = { ...entry, authorized: true };
  }

  async #finish<T extends Json>(entry: Entry, dispatch: () => Promise<T>): Promise<T> {
    await this.#authorize(entry);
    let outcome: Settlement<T>;
    try {
      outcome = { status: "resolved", value: copyJsonWithLimit(await dispatch(), MAX_ARTIFACT_BYTES) as T };
    } catch (error) {
      if (!(error instanceof CommittedRejection)) throw new Error("OUTCOME_UNKNOWN", { cause: error });
      outcome = { status: "rejected", error: { code: error.code, message: error.message } };
    }
    let postWorkspace: WorkspaceManifest;
    let committedEvent: DurableEvent;
    try {
      postWorkspace = await captureWorkspace(this.#baseline.root, this.#baseline.policy);
      const outcomeArtifact = await publishValue(this.#options.runDirectory, `outcome-${entry.prepared.ordinal}`, outcome as unknown as Json);
      const postWorkspaceArtifact = await publishWorkspace(this.#options.runDirectory, `workspace-after-${entry.prepared.ordinal}.json`, postWorkspace);
      const commands = this.#entries.filter(({ prepared }) => prepared.reservation.commands === 1).length;
      const agentCalls = this.#entries.filter(({ prepared }) => prepared.reservation.agentCalls === 1).length;
      committedEvent = await this.#options.journal.append("operation.committed", {
        preparedHash: entry.preparedHash, outcome: null, outcomeArtifact, postWorkspaceArtifact, counters: { commands, agentCalls },
      } as unknown as Json);
    } catch (error) {
      throw new Error("OUTCOME_UNKNOWN", { cause: error });
    }
    const committed = { ...committedSchema.parse(committedEvent.data), outcome: outcome as unknown as z.infer<typeof committedSchema.shape.outcome> };
    this.#entries[entry.prepared.ordinal - 1] = { ...entry, authorized: true, committed, postWorkspace };
    this.#cursor += 1;
    this.#baseline = postWorkspace;
    return this.#deliver(outcome as unknown as Json, entry.prepared.kind) as T;
  }

  #deliver(outcome: Json, kind: OperationKind): Json {
    if (!isJsonObject(outcome) || !("status" in outcome)) throw new Error("EVIDENCE_CORRUPT");
    if (outcome.status === "resolved" && "value" in outcome) {
      const value = copyJsonWithLimit(outcome.value, MAX_ARTIFACT_BYTES);
      if (kind === "read" && typeof value === "string" && Buffer.byteLength(value, "utf8") > MAX_JSON_BYTES) {
        throw Object.assign(new Error("READ_LIMIT"), { code: "READ_LIMIT" });
      }
      return value;
    }
    if (outcome.status === "rejected" && "error" in outcome && isJsonObject(outcome.error)
      && typeof outcome.error.code === "string" && typeof outcome.error.message === "string") {
      throw new CommittedRejection(outcome.error.code, outcome.error.message);
    }
    throw new Error("EVIDENCE_CORRUPT");
  }

  #match(entry: Entry, kind: OperationKind, request: Json): void {
    if (entry.prepared.kind !== kind || entry.prepared.requestHash !== hash(request)
      || canonicalJson(entry.prepared.request) !== canonicalJson(request)) throw new Error("HISTORY_MISMATCH");
  }

  assertConsumed(): void {
    if (this.#cursor !== this.#entries.length) throw new Error("HISTORY_MISMATCH");
  }

  async assertFresh(): Promise<void> {
    await assertFresh(this.#baseline);
  }
}
