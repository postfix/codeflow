import { assertContainedPath, readBoundedFile } from "../artifacts.js";
import { copyJson, type Json } from "../contracts.js";
import type { ProcessService, RunnerReturn } from "../process.js";
import {
  assertNoConflictingSelectors, nativeStatus, ProviderFailure, requireSuccessfulProbe, runStatusProbe, validateCaptureContext,
  type Adapter, type NativeCaptureContext, type NativeProviderEvidence, type ProviderRequest, type ProviderResult, type Qualification, type RuntimeStatus,
} from "./types.js";

export const CLAUDE_VERSION = "2.1.274";
const CONFLICTING_SELECTORS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
] as const;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function versionFrom(output: string): string | undefined {
  return /^(\d+\.\d+\.\d+)(?:\s|$)/.exec(output.trim())?.[1];
}

export function decodeClaudeAuth(output: string): RuntimeStatus["auth"] {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { return "unknown"; }
  const status = object(parsed);
  if (!status) return "unknown";
  if (status.loggedIn === false) return "logged-out";
  if (status.loggedIn !== true) return "unknown";
  const method = typeof status.authMethod === "string" ? status.authMethod.toLowerCase() : "";
  const subscription = typeof status.subscriptionType === "string" ? status.subscriptionType.toLowerCase() : "";
  if (method === "claude.ai" && status.apiProvider === "firstParty"
    && ["pro", "max", "team", "enterprise"].includes(subscription)) return "subscription";
  return method || subscription ? "other" : "unknown";
}

function optionalCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

export async function captureClaudeEvidence(request: ProviderRequest, returned: RunnerReturn, context: NativeCaptureContext): Promise<NativeProviderEvidence> {
  validateCaptureContext(context);
  if (returned.stdoutPath) await assertContainedPath(request.operationDirectory, returned.stdoutPath);
  return { version: 1, captureContext: context, status: nativeStatus(returned),
    stdout: returned.stdoutPath ? await readBoundedFile(returned.stdoutPath, 16 * 1024 * 1024) : null };
}

export async function decodeClaudeResult(request: ProviderRequest, evidence: NativeProviderEvidence): Promise<ProviderResult> {
  validateCaptureContext(evidence.captureContext);
  if (evidence.version !== 1 || evidence.finalOutput !== undefined || evidence.codexSession !== undefined || !evidence.stdout) throw new Error("Claude native evidence is incomplete");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(evidence.stdout); }
  catch { throw new Error("Claude stream is not valid UTF-8"); }
  if (evidence.stdout.length > 16 * 1024 * 1024) throw new Error("Claude stream exceeds 16 MiB");
  const events: Record<string, unknown>[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line) continue;
    if (Buffer.byteLength(line, "utf8") > 2 * 1024 * 1024) throw new Error("Claude stream record exceeds 2 MiB");
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new Error(`Malformed Claude stream record ${index + 1}`); }
    const event = object(parsed);
    if (!event || typeof event.type !== "string") throw new Error(`Malformed Claude stream record ${index + 1}`);
    events.push(event);
  }
  const init = events.filter((event) => event.type === "system" && event.subtype === "init");
  const terminal = events.filter((event) => event.type === "result");
  if (init.length !== 1 || terminal.length !== 1) throw new Error("Claude native identity or terminal is ambiguous");
  const envelope = terminal[0]!;
  const denials = envelope.permission_denials;
  if (Array.isArray(denials) && denials.length > 0) throw new ProviderFailure("PERMISSION_DENIED", "Claude permission denial");
  if (denials !== undefined && !Array.isArray(denials)) throw new Error("Invalid Claude permission-denial list");
  if (evidence.status.exitCode !== 0 || evidence.status.signal !== null || evidence.status.errorPresent) throw new Error("Claude attempt failed");
  if (envelope.subtype !== "success" || envelope.is_error === true) {
    throw new Error("Claude terminal outcome is not successful");
  }
  const root = events.filter((event) => {
    if (event.type !== "assistant") return false;
    if (event.parent_tool_use_id === null || event.parent_tool_use_id === undefined) return true;
    if (typeof event.parent_tool_use_id === "string" && event.parent_tool_use_id.length > 0) return false;
    throw new Error("Malformed Claude parent tool use ID");
  });
  const actualModel = init[0]!.model;
  if (!request.model || actualModel !== request.model || root.length === 0
    || root.some((event) => object(event.message)?.model !== actualModel)) throw new Error("MODEL_MISMATCH");
  const sessions = [init[0]!.session_id, envelope.session_id, ...root.map((event) => event.session_id)];
  if (sessions.some((session) => typeof session !== "string" || !session)
    || new Set(sessions).size !== 1) throw new Error("Claude session identity mismatch");
  const usage = object(envelope.usage);
  const inputTokens = optionalCount(usage?.input_tokens);
  const outputTokens = optionalCount(usage?.output_tokens);
  const cachedInputTokens = optionalCount(usage?.cache_read_input_tokens);
  const normalizedUsage = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
  const base = {
    sessionId: envelope.session_id as string,
    actualModel: actualModel as string,
    ...(Object.keys(normalizedUsage).length > 0 ? { usage: normalizedUsage } : {}),
  };
  let result: ProviderResult;
  if (request.schema) {
    if (envelope.structured_output === undefined) throw new Error("Claude structured output is missing");
    let structured: Json;
    try { structured = copyJson(envelope.structured_output); } catch { throw new Error("Claude structured output is invalid"); }
    result = { ...base, structured };
  } else {
    if (typeof envelope.result !== "string") throw new Error("Claude text result is missing");
    result = { ...base, text: envelope.result };
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 1024 * 1024) throw new Error("Claude normalized result exceeds 1 MiB");
  return result;
}

export function claudeAdapter(processes: ProcessService, qualification: Qualification): Adapter {
  const executable = qualification.executable ?? "claude";
  const expectedVersion = qualification.version ?? CLAUDE_VERSION;
  const environment = qualification.environment ?? process.env;
  return {
    async status(signal) {
      assertNoConflictingSelectors(environment, CONFLICTING_SELECTORS);
      let versionOutput: string;
      try {
        versionOutput = requireSuccessfulProbe(await runStatusProbe(processes, {
          executable, args: ["--version"], cwd: qualification.operationDirectory, stdin: "",
        }, qualification.operationDirectory, signal), "Claude version probe");
      } catch { throw new Error("RUNTIME_UNQUALIFIED"); }
      const version = versionFrom(versionOutput) ?? "unknown";
      if (version !== expectedVersion) return { provider: "claude", executable, version, auth: "unknown", qualified: false };
      const authProbe = await runStatusProbe(processes, {
        executable, args: ["auth", "status"], cwd: qualification.operationDirectory, stdin: "",
      }, qualification.operationDirectory, signal);
      try { requireSuccessfulProbe(authProbe, "Claude auth probe"); }
      catch { throw new Error("AUTH_UNVERIFIED"); }
      const authOutput = authProbe.stderr.trim() ? "" : authProbe.stdout;
      const auth = decodeClaudeAuth(authOutput);
      return { provider: "claude", executable, version, auth, qualified: true };
    },
    invocation(request) {
      if (!request.model) throw new Error("CONFIG_UNVERIFIED: an explicit Claude model is required");
      const schema = request.schema ? JSON.stringify(request.schema) : undefined;
      if (schema && Buffer.byteLength(schema, "utf8") > 64 * 1024) throw new Error("Claude schema exceeds 64 KiB");
      const tools = request.access === "write" ? "Read,Glob,Grep,Edit,Write" : "Read,Glob,Grep";
      return {
        executable,
        args: [
          "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk",
          "--tools", tools, "--allowedTools", tools, "--disallowedTools", "mcp__*",
          ...(schema ? ["--json-schema", schema] : []), "--model", request.model,
        ],
        cwd: request.workspace,
        stdin: request.prompt,
      };
    },
    capture: captureClaudeEvidence,
    decode: decodeClaudeResult,
  };
}
