import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertContainedPath, readBoundedFile } from "../artifacts.js";
import { copyJson, type Json } from "../contracts.js";
import type { ProcessService, RunnerReturn } from "../process.js";
import {
  assertNoConflictingSelectors, nativeStatus, requireSuccessfulProbe, runStatusProbe, validateCaptureContext,
  type Adapter, type CodexSessionEvidence, type NativeCaptureContext, type NativeProviderEvidence,
  type ProviderRequest, type ProviderResult, type Qualification, type RuntimeStatus,
} from "./types.js";

export const CODEX_VERSION = "0.154.0";
const CONFLICTING_SELECTORS = [
  "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE",
  "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT",
] as const;

function versionFrom(output: string): string | undefined {
  return /(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+)/i.exec(output)?.[1];
}

export function decodeCodexAuth(output: string): RuntimeStatus["auth"] {
  if (output.trim() === "Not logged in") return "logged-out";
  if (output.trim() === "Logged in using ChatGPT") return "subscription";
  if (output.trim().startsWith("Logged in using an API key")) return "other";
  return "unknown";
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function optionalCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function codexEvents(raw: Uint8Array): Record<string, unknown>[] {
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
  catch { throw new Error("Codex JSONL is not valid UTF-8"); }
  if (raw.length > 64 * 1024 * 1024) throw new Error("Codex JSONL exceeds 64 MiB");
  const lines = decoded.split("\n");
  const events: Record<string, unknown>[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, "utf8") > 2 * 1024 * 1024) throw new Error("Codex JSONL record exceeds 2 MiB");
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new Error(`Malformed Codex JSONL record ${String(index + 1)}`); }
    const event = object(parsed);
    if (!event || typeof event.type !== "string") throw new Error(`Malformed Codex JSONL record ${String(index + 1)}`);
    events.push(event);
  }
  return events;
}

function threadId(events: readonly Record<string, unknown>[]): string {
  const ids = events.filter(({ type }) => type === "thread.started").map(({ thread_id }) => thread_id);
  if (ids.length !== 1 || typeof ids[0] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ids[0])) {
    throw new Error("Codex thread identity is missing or ambiguous");
  }
  return ids[0];
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export async function captureCodexEvidence(request: ProviderRequest, returned: RunnerReturn, context: NativeCaptureContext,
  environment: Readonly<NodeJS.ProcessEnv> = process.env): Promise<NativeProviderEvidence> {
  validateCaptureContext(context);
  if (!returned.stdoutPath) throw new Error("Codex stdout evidence is missing");
  await assertContainedPath(request.operationDirectory, returned.stdoutPath);
  const stdout = await readBoundedFile(returned.stdoutPath, 64 * 1024 * 1024);
  const finalPath = join(request.operationDirectory, "final.txt");
  await assertContainedPath(request.operationDirectory, finalPath);
  const finalOutput = await readBoundedFile(finalPath, 1024 * 1024);
  const id = threadId(codexEvents(stdout));
  const root = await realpath(environment.CODEX_HOME || join(homedir(), ".codex"));
  const workspace = await realpath(request.workspace);
  const startDay = Math.floor(Date.parse(context.startedAt) / 86_400_000);
  const endDay = Math.floor(Date.parse(context.returnedAt) / 86_400_000);
  const candidates: string[] = [];
  for (let day = startDay; day <= endDay; day += 1) {
    const date = new Date(day * 86_400_000).toISOString();
    const parts = ["sessions", date.slice(0, 4), date.slice(5, 7), date.slice(8, 10)];
    let directory = root;
    let absent = false;
    for (const part of parts) {
      directory = join(directory, part);
      const info = await lstat(directory).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") { absent = true; return undefined; }
        throw error;
      });
      if (absent) break;
      if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error("Codex session directory is unsafe");
    }
    if (absent) continue;
    const handle = await opendir(directory);
    let count = 0;
    try {
      for await (const entry of handle) {
        if (++count > 4096) throw new Error("Codex session directory exceeds 4096 entries");
        if (entry.name.endsWith(`${id}.jsonl`)) candidates.push(join(directory, entry.name));
      }
    } finally { await handle.close().catch(() => undefined); }
  }
  if (candidates.length !== 1) throw new Error("Codex session candidate is missing or ambiguous");
  const file = await open(candidates[0]!, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || before.size > 32 * 1024 * 1024) throw new Error("Codex session file is unsafe");
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, 32 * 1024 * 1024 + 1 - total));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > 32 * 1024 * 1024) throw new Error("Codex session exceeds 32 MiB");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    bytes = Buffer.concat(chunks, total);
    const after = await file.stat();
    if (bytes.length > 32 * 1024 * 1024 || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs) throw new Error("Codex session file changed");
  } finally { await file.close(); }
  let sessionText: string;
  try { sessionText = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("Codex session is not valid UTF-8"); }
  let header: Record<string, unknown> | undefined;
  let promptCount = 0;
  let promptMatches = 0;
  const models: string[] = [];
  for (const [index, line] of sessionText.split("\n").entries()) {
    if (!line) continue;
    if (Buffer.byteLength(line, "utf8") > 2 * 1024 * 1024) throw new Error("Codex session record exceeds 2 MiB");
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new Error(`Malformed Codex session record ${index + 1}`); }
    const record = object(parsed);
    const payload = object(record?.payload);
    if (!record || !payload) throw new Error("Malformed Codex session record");
    if (record.type === "session_meta") {
      if (header) throw new Error("Codex session header is ambiguous");
      header = payload;
    }
    if (record.type === "turn_context") {
      if (typeof payload.model !== "string") throw new Error("Codex turn model is missing");
      models.push(payload.model);
    }
    if (record.type === "response_item" && payload.type === "message" && payload.role === "user") {
      const content = payload.content;
      if (Array.isArray(content) && content.length === 1 && object(content[0])?.type === "input_text") {
        promptCount += 1;
        if (object(content[0])?.text === request.prompt) promptMatches += 1;
      }
    }
  }
  const startedAt = header?.timestamp;
  if (header?.id !== id || header.source !== "exec" || header.cli_version !== CODEX_VERSION
    || header.cwd !== workspace || typeof startedAt !== "string" || !Number.isFinite(Date.parse(startedAt))
    || Date.parse(startedAt) < Date.parse(context.startedAt) || Date.parse(startedAt) > Date.parse(context.returnedAt)
    || promptCount !== 1 || promptMatches !== 1 || models.length === 0 || !request.model || models.some((model) => model !== request.model)) {
    throw new Error("Codex session join failed");
  }
  const codexSession: CodexSessionEvidence = { sessionIdSha256: sha256(id), source: "exec", cliVersion: CODEX_VERSION,
    workspaceSha256: sha256(workspace), promptSha256: sha256(request.prompt), startedAt,
    models };
  return { version: 1, captureContext: context, status: nativeStatus(returned), stdout, finalOutput, codexSession };
}

export async function decodeCodexResult(request: ProviderRequest, evidence: NativeProviderEvidence): Promise<ProviderResult> {
  validateCaptureContext(evidence.captureContext);
  if (evidence.version !== 1 || evidence.status.exitCode !== 0 || evidence.status.signal !== null || evidence.status.errorPresent) throw new Error("Codex attempt failed");
  if (!evidence.stdout || !evidence.finalOutput || !evidence.codexSession) throw new Error("Codex native evidence is incomplete");
  const events = codexEvents(evidence.stdout);
  const id = threadId(events);
  const session = evidence.codexSession;
  const startedAt = Date.parse(session.startedAt);
  if (session.source !== "exec" || session.cliVersion !== CODEX_VERSION || session.sessionIdSha256 !== sha256(id)
    || session.workspaceSha256 !== sha256(request.workspace) || session.promptSha256 !== sha256(request.prompt)
    || !Number.isFinite(startedAt) || startedAt < Date.parse(evidence.captureContext.startedAt)
    || startedAt > Date.parse(evidence.captureContext.returnedAt)
    || !request.model || session.models.length === 0 || session.models.some((model) => model !== request.model)) throw new Error("MODEL_MISMATCH");
  const terminals = events.filter(({ type }) => type === "turn.completed" || type === "turn.failed" || type === "error");
  if (terminals.length !== 1 || terminals[0]?.type !== "turn.completed") throw new Error("Codex terminal outcome is missing or conflicting");
  if (events.some(({ type }) => typeof type === "string" && type.startsWith("turn.")
    && !["turn.started", "turn.completed", "turn.failed"].includes(type))) {
    throw new Error("Unqualified Codex terminal event");
  }
  const finalText = new TextDecoder("utf-8", { fatal: true }).decode(evidence.finalOutput);
  const terminal = terminals[0]!;
  const actualModel = request.model;
  const usage = object(terminal.usage);
  const inputTokens = optionalCount(usage?.input_tokens);
  const outputTokens = optionalCount(usage?.output_tokens);
  const cachedInputTokens = optionalCount(usage?.cached_input_tokens);
  const normalizedUsage = usage ? {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  } : undefined;
  const sessionId = id;
  const base = {
    ...(sessionId ? { sessionId } : {}),
    ...(actualModel ? { actualModel } : {}),
    ...(normalizedUsage && Object.keys(normalizedUsage).length > 0 ? { usage: normalizedUsage } : {}),
  };
  if (request.schema) {
    let structured: Json;
    try { structured = copyJson(JSON.parse(finalText)); } catch { throw new Error("Codex structured final output is invalid JSON"); }
    return { ...base, structured };
  }
  return { ...base, text: finalText };
}

export function codexAdapter(processes: ProcessService, qualification: Qualification): Adapter {
  const executable = qualification.executable ?? "codex";
  const expectedVersion = qualification.version ?? CODEX_VERSION;
  const environment = qualification.environment ?? process.env;
  return {
    async status(signal) {
      assertNoConflictingSelectors(environment, CONFLICTING_SELECTORS);
      let versionOutput: string;
      try {
        versionOutput = requireSuccessfulProbe(await runStatusProbe(processes, {
          executable, args: ["--version"], cwd: qualification.operationDirectory, stdin: "",
        }, qualification.operationDirectory, signal), "Codex version probe");
      } catch { throw new Error("RUNTIME_UNQUALIFIED"); }
      const version = versionFrom(versionOutput) ?? "unknown";
      if (version !== expectedVersion) return { provider: "codex", executable, version, auth: "unknown", qualified: false };
      const authProbe = await runStatusProbe(processes, {
        executable, args: ["login", "status"], cwd: qualification.operationDirectory, stdin: "",
      }, qualification.operationDirectory, signal);
      try { requireSuccessfulProbe(authProbe, "Codex auth probe"); }
      catch { throw new Error("AUTH_UNVERIFIED"); }
      const authOutput = `${authProbe.stdout}\n${authProbe.stderr}`;
      const auth = decodeCodexAuth(authOutput);
      return { provider: "codex", executable, version, auth, qualified: true };
    },
    invocation(request) {
      if (!request.model) throw new Error("CONFIG_UNVERIFIED: an explicit Codex model is required");
      return {
        executable,
        args: [
          "--ask-for-approval", "never", "-c", "forced_login_method=\"chatgpt\"", "exec", "--json", "--color", "never",
          "--cd", request.workspace, "--sandbox", request.access === "write" ? "workspace-write" : "read-only",
          "--output-last-message", join(request.operationDirectory, "final.txt"),
          ...(request.schema ? ["--output-schema", join(request.operationDirectory, "schema.json")] : []),
          "--model", request.model, "-",
        ],
        cwd: request.workspace,
        stdin: request.prompt,
      };
    },
    capture: (request, returned, context) => captureCodexEvidence(request, returned, context, environment),
    decode: decodeCodexResult,
  };
}
