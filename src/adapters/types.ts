import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { artifactRefSchema, canonicalJson, type Json } from "../contracts.js";
import type { ProcessService, RunnerReturn } from "../process.js";
import type { Access, Provider } from "../sdk.js";

export interface RuntimeStatus {
  readonly provider: Provider;
  readonly executable: string;
  readonly version: string;
  readonly auth: "subscription" | "other" | "logged-out" | "unknown";
  readonly qualified: boolean;
}

export type ProviderFailureCode = "AUTH_REQUIRED" | "AUTH_UNVERIFIED" | "PERMISSION_DENIED" | "AGENT_FAILED" | "OUTCOME_UNKNOWN";
export class ProviderFailure extends Error {
  constructor(readonly code: ProviderFailureCode, message: string = code) { super(message); }
}
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const providerObservationSchema = z.object({
  provider: z.enum(["codex", "claude"]), phase: z.enum(["preflight", "terminal"]),
  runId: z.string().uuid(), boundaryId: z.string().regex(/^[a-zA-Z0-9-]{1,128}$/), ordinal: z.number().int().positive(), preparedHash: digest,
  attempt: z.number().int().positive(), ownershipGeneration: z.number().int().positive(),
  executableSha256: digest, configurationSha256: digest, executableVersion: z.string().min(1).max(64),
  auth: z.enum(["subscription", "other", "logged-out", "unknown"]), requestedModel: z.string().min(1).max(256),
  actualModel: z.string().min(1).max(256).optional(), sessionIdSha256: digest.optional(),
  usage: z.object({ inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(), cachedInputTokens: z.number().int().nonnegative().optional() }).strict().optional(),
  outcome: z.enum(["ready", "succeeded", "AUTH_REQUIRED", "AUTH_UNVERIFIED", "PERMISSION_DENIED", "AGENT_FAILED", "OUTCOME_UNKNOWN"]),
  nativeEvidenceArtifact: artifactRefSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.phase === "terminal") !== (value.nativeEvidenceArtifact !== undefined)) {
    context.addIssue({ code: "custom", message: "Terminal native evidence reference mismatch" });
  }
});
export type ProviderObservation = z.infer<typeof providerObservationSchema>;
export type RecordProviderObservation = (observation: ProviderObservation) => Promise<void>;
export function providerConfigurationHash(provider: string, model: string, request: Json, executableSha256: string): string {
  return createHash("sha256").update(canonicalJson({ provider, model, request, executableSha256 })).digest("hex");
}

export interface ProviderRequest {
  readonly prompt: string;
  readonly schema?: Readonly<Record<string, Json>>;
  readonly access: Access;
  readonly model?: string;
  readonly workspace: string;
  readonly operationDirectory: string;
  readonly timeoutMs: number;
}

export interface ProviderResult {
  readonly text?: string;
  readonly structured?: Json;
  readonly sessionId?: string;
  readonly actualModel?: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
  };
}

export interface NativeCaptureContext {
  readonly startedAt: string;
  readonly returnedAt: string;
}

export interface CodexSessionEvidence {
  readonly sessionIdSha256: string;
  readonly source: "exec";
  readonly cliVersion: "0.154.0";
  readonly workspaceSha256: string;
  readonly promptSha256: string;
  readonly startedAt: string;
  readonly models: readonly string[];
}
export const codexSessionEvidenceSchema = z.object({
  sessionIdSha256: digest, source: z.literal("exec"), cliVersion: z.literal("0.154.0"),
  workspaceSha256: digest, promptSha256: digest, startedAt: z.string().min(1),
  models: z.array(z.string().min(1).max(256)).min(1),
}).strict();

export interface NativeProviderEvidence {
  readonly version: 1;
  readonly captureContext: NativeCaptureContext;
  readonly status: { readonly exitCode: number | null; readonly signal: string | null; readonly errorPresent: boolean };
  readonly stdout: Uint8Array | null;
  readonly finalOutput?: Uint8Array;
  readonly codexSession?: CodexSessionEvidence;
}

export const nativeEvidenceSnapshotSchema = z.object({
  version: z.literal(1),
  captureContext: z.object({ startedAt: z.iso.datetime(), returnedAt: z.iso.datetime() }).strict(),
  status: z.object({ exitCode: z.number().int().nullable(), signal: z.string().nullable(), errorPresent: z.boolean() }).strict(),
  stdoutArtifact: artifactRefSchema.nullable(),
  finalOutputArtifact: artifactRefSchema.optional(),
  codexSessionArtifact: artifactRefSchema.optional(),
}).strict();
export type NativeEvidenceSnapshot = z.infer<typeof nativeEvidenceSnapshotSchema>;

export function validateCaptureContext(context: NativeCaptureContext): void {
  const start = Date.parse(context.startedAt), end = Date.parse(context.returnedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end
    || (Math.floor(end / 86_400_000) - Math.floor(start / 86_400_000)) > 1
    || new Date(start).toISOString() !== context.startedAt || new Date(end).toISOString() !== context.returnedAt) {
    throw new Error("NATIVE_CAPTURE_INTERVAL_INVALID");
  }
}

export function nativeStatus(returned: RunnerReturn): NativeProviderEvidence["status"] {
  return { exitCode: returned.exitCode, signal: returned.signal, errorPresent: returned.error !== undefined };
}

export interface ProcessInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
}

export interface Qualification {
  readonly executable?: string | undefined;
  readonly version?: string | undefined;
  readonly operationDirectory: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}

export interface Adapter {
  status(signal: AbortSignal): Promise<RuntimeStatus>;
  invocation(request: ProviderRequest): ProcessInvocation;
  capture(request: ProviderRequest, returned: RunnerReturn, context: NativeCaptureContext): Promise<NativeProviderEvidence>;
  decode(request: ProviderRequest, evidence: NativeProviderEvidence): Promise<ProviderResult>;
}

export async function runStatusProbe(
  processes: ProcessService,
  request: ProcessInvocation,
  operationDirectory: string,
  signal: AbortSignal,
): Promise<RunnerReturn> {
  if (signal.aborted) throw new Error("Provider status probe cancelled");
  await mkdir(operationDirectory, { recursive: true, mode: 0o700 });
  const attemptId = `provider-status-${randomUUID()}`;
  const registered = await processes.register({
    attemptId,
    executable: request.executable,
    args: request.args,
    cwd: request.cwd,
    stdin: request.stdin,
    timeoutMs: 10_000,
    evidenceDirectory: operationDirectory,
  });
  const cancel = (): void => { processes.terminate(registered, "provider status probe cancelled").catch(() => undefined); };
  if (signal.aborted) { await processes.terminate(registered, "provider status probe cancelled"); throw new Error("Provider status probe cancelled"); }
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await processes.authorizeTarget(registered, { attemptId, nonce: registered.nonce }, 256 * 1024);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export function assertNoConflictingSelectors(environment: Readonly<NodeJS.ProcessEnv>, names: readonly string[]): void {
  const conflict = names.find((name) => environment[name] !== undefined && environment[name] !== "");
  if (conflict) throw new Error(`AUTH_CONFLICT: ${conflict}`);
}

export function requireSuccessfulProbe(returned: RunnerReturn, label: string): string {
  if (returned.error === "OUTPUT_LIMIT" || returned.truncated) throw new Error(`${label} output exceeded 256 KiB`);
  if (returned.exitCode !== 0 || returned.signal !== null || returned.error) throw new Error(`${label} failed`);
  return returned.stdout.trim();
}

export async function preflightProvider(adapter: Adapter, signal: AbortSignal): Promise<RuntimeStatus> {
  const status = await adapter.status(signal);
  if (!status.qualified) throw new Error("RUNTIME_UNQUALIFIED");
  if (status.auth === "logged-out") throw new ProviderFailure("AUTH_REQUIRED");
  if (status.auth !== "subscription") throw new ProviderFailure("AUTH_UNVERIFIED");
  return status;
}

export function buildProviderInvocation(adapter: Adapter, request: ProviderRequest): ProcessInvocation {
  return adapter.invocation(request);
}
