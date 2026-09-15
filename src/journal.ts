import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { assertContainedPath, readBoundedFile, syncDirectory, writeAll } from "./artifacts.js";
import { artifactRefSchema, assertRunId, canonicalJson, runManifestSchema, type JournalEvent, type Json } from "./contracts.js";

const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;

const journalEventSchema = z.object({
  version: z.literal(2),
  runId: z.string(),
  sequence: z.number().int().positive(),
  ownershipGeneration: z.literal(1),
  timestamp: z.string().min(1),
  type: z.enum(["run.created", "run.initialized", "run.succeeded", "run.failed"]),
  data: z.json(),
  previousHash: z.string().regex(/^[0-9a-f]{64}$/),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const eventDataSchemas = {
  "run.created": runManifestSchema.extend({ supervisorPid: z.number().int().positive() }),
  "run.initialized": z.object({
    bundleArtifact: artifactRefSchema,
    inputArtifact: artifactRefSchema,
    initializationCharges: z.object({ compilations: z.literal(1), inputValidations: z.literal(1) }).strict(),
    supervisorPid: z.number().int().positive(),
  }).strict(),
  "run.succeeded": z.object({ outputArtifact: artifactRefSchema }).strict(),
  "run.failed": z.object({ errorArtifact: artifactRefSchema }).strict(),
} as const;

export class Journal {
  readonly #path: string;
  readonly #runId: string;
  #sequence = 0;
  #previousHash = "0".repeat(64);
  #uncertain = false;

  constructor(runDirectory: string, runId: string, verifiedHistory: readonly JournalEvent[] = []) {
    this.#path = join(runDirectory, "events.jsonl");
    this.#runId = runId;
    const last = verifiedHistory.at(-1);
    if (last) {
      this.#sequence = last.sequence;
      this.#previousHash = last.hash;
    }
  }

  async append(type: JournalEvent["type"], data: Json): Promise<JournalEvent> {
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
    const event: JournalEvent = { ...unsigned, hash };
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    if (bytes.length > MAX_EVENT_BYTES) throw new Error("Journal event exceeds 256 KiB limit");
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

export async function readVerifiedEvents(workspace: string, runId: string): Promise<readonly JournalEvent[]> {
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
      return parsed.data as JournalEvent;
    } catch {
      throw new Error("Corrupt journal");
    }
  });
  let previousHash = "0".repeat(64);
  let state: "empty" | "created" | "initialized" | "terminal" = "empty";
  for (const [index, event] of events.entries()) {
    const { hash, ...unsigned } = event;
    const expected = createHash("sha256").update(canonicalJson(unsigned as unknown as Json)).digest("hex");
    if (event.runId !== runId || event.sequence !== index + 1 || event.previousHash !== previousHash || hash !== expected) {
      throw new Error("Corrupt journal");
    }
    if (event.type === "run.created" && state === "empty") state = "created";
    else if (event.type === "run.initialized" && state === "created") state = "initialized";
    else if (event.type === "run.succeeded" && state === "initialized") state = "terminal";
    else if (event.type === "run.failed" && (state === "created" || state === "initialized")) state = "terminal";
    else throw new Error("Corrupt journal");
    previousHash = hash;
  }
  return events;
}
