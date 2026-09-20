import { z } from "zod";

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const forbiddenSchemaKinds = new Set(["catch", "default", "pipe", "prefault", "promise", "transform"]);

type ZodInternals = { readonly _zod: { readonly def: Record<string, unknown> } };

function isZodSchema(value: unknown): value is ZodInternals {
  return typeof value === "object" && value !== null && "_zod" in value;
}

function inspectSchemaValue(value: unknown, seen: Set<object>): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  if (value instanceof RegExp && value.flags) throw new Error("Unsupported contract: regular expression flags cannot be represented");
  seen.add(value);
  if (isZodSchema(value)) {
    const definition = value._zod.def;
    if (forbiddenSchemaKinds.has(String(definition.type)) || definition.coerce === true) {
      throw new Error("Unsupported contract: transformations, coercions, and defaults are forbidden");
    }
    if (definition.type === "custom" || definition.check === "custom") {
      throw new Error("Unsupported contract: asynchronous validation is forbidden");
    }
    inspectSchemaValue(definition, seen);
    return;
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) inspectSchemaValue(item, seen);
}

export function assertPortableContract(schema: z.ZodType): void {
  try {
    z.toJSONSchema(schema, { target: "draft-7" });
    inspectSchemaValue(schema, new Set());
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unsupported contract:")) throw error;
    throw new Error(`Unsupported contract: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function portableContract(schema: z.ZodType): Json {
  assertPortableContract(schema);
  return copyJson(z.toJSONSchema(schema, { target: "draft-7" }));
}

const humanContractKeywords = new Set([
  "$schema", "type", "const", "enum", "anyOf", "properties", "required", "additionalProperties", "items",
  "minLength", "maxLength", "pattern", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems",
  "title", "description", "examples", "readOnly",
]);

function assertHumanContractNode(value: Json, root = false): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Unsupported human contract");
  const node = value as { readonly [key: string]: Json };
  if (Object.keys(node).some((key) => !humanContractKeywords.has(key))) throw new Error("Unsupported human contract keyword");
  if (root && node.$schema !== "http://json-schema.org/draft-07/schema#") throw new Error("Unsupported human contract draft");
  if (Array.isArray(node.anyOf)) {
    if (node.anyOf.length === 0 || node.type !== undefined) throw new Error("Unsupported human contract union");
    for (const branch of node.anyOf) assertHumanContractNode(branch);
    return;
  }
  const type = node.type;
  if (!["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(type))) {
    throw new Error("Unsupported human contract type");
  }
  if (node.const === undefined && node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) {
    throw new Error("Unsupported human contract enum");
  }
  if (type === "object") {
    if (typeof node.properties !== "object" || node.properties === null || Array.isArray(node.properties)
      || node.additionalProperties !== false || !Array.isArray(node.required)
      || !node.required.every((key) => typeof key === "string" && key in (node.properties as object))) {
      throw new Error("Unsupported human object contract");
    }
    for (const child of Object.values(node.properties)) assertHumanContractNode(child);
  } else if (type === "array") {
    if (typeof node.items !== "object" || node.items === null || Array.isArray(node.items)) throw new Error("Unsupported human array contract");
    assertHumanContractNode(node.items);
  } else if (type === "string") {
    for (const key of ["minLength", "maxLength"] as const) {
      if (node[key] !== undefined && (!Number.isSafeInteger(node[key]) || Number(node[key]) < 0)) throw new Error("Unsupported human string contract");
    }
    if (node.pattern !== undefined) {
      if (typeof node.pattern !== "string") throw new Error("Unsupported human string pattern");
      try { new RegExp(node.pattern, "u"); } catch { throw new Error("Unsupported human string pattern"); }
    }
  } else if (type === "number" || type === "integer") {
    for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
      if (node[key] !== undefined && (typeof node[key] !== "number" || !Number.isFinite(node[key]))) {
        throw new Error("Unsupported human numeric contract");
      }
    }
    if (node.multipleOf !== undefined
      && (typeof node.multipleOf !== "number" || !Number.isFinite(node.multipleOf) || node.multipleOf <= 0)) {
      throw new Error("Unsupported human numeric contract");
    }
  }
  for (const key of ["minItems", "maxItems"] as const) {
    if (node[key] !== undefined && (!Number.isSafeInteger(node[key]) || Number(node[key]) < 0)) throw new Error("Unsupported human array contract");
  }
}

export function portableHumanContract(schema: z.ZodType): Json {
  const contract = portableContract(schema);
  assertHumanContractNode(contract, true);
  return contract;
}

export function portableAgentContract(schema: z.ZodType): Json {
  const contract = portableContract(schema);
  const inspect = (value: Json, root: boolean): void => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Unsupported agent contract");
    const node = value as { readonly [key: string]: Json };
    if (root && node.type !== "object") throw new Error("Unsupported agent contract: root must be an object");
    if (node.type === "object") {
      if (node.additionalProperties !== false || typeof node.properties !== "object" || node.properties === null || Array.isArray(node.properties)) {
        throw new Error("Unsupported agent contract: objects must be strict");
      }
      const properties = node.properties as { readonly [key: string]: Json };
      const required = Array.isArray(node.required) ? node.required : [];
      if (required.length !== Object.keys(properties).length || !Object.keys(properties).every((key) => required.includes(key))) {
        throw new Error("Unsupported agent contract: properties must be required");
      }
      for (const child of Object.values(properties)) inspect(child, false);
    } else if (node.type === "array") {
      if (!("items" in node)) throw new Error("Unsupported agent contract: arrays need items");
      inspect(node.items as Json, false);
    } else if (Array.isArray(node.type)) {
      if (node.type.length !== 2 || !node.type.includes("null")
        || !node.type.some((type) => ["string", "boolean", "number", "integer"].includes(String(type)))) {
        throw new Error("Unsupported agent contract");
      }
    } else if (Array.isArray(node.anyOf)) {
      if (node.anyOf.length !== 2 || !node.anyOf.some((item) => typeof item === "object" && item !== null && !Array.isArray(item)
        && (item as { readonly type?: Json }).type === "null")) throw new Error("Unsupported agent contract");
      for (const child of node.anyOf) inspect(child, false);
    } else if (!["string", "boolean", "number", "integer", "null"].includes(String(node.type))) {
      throw new Error("Unsupported agent contract");
    }
  };
  inspect(contract, true);
  return contract;
}

function copyJsonValue(value: unknown, seen: Set<object>): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Input must be finite JSON");
    return value;
  }
  if (typeof value !== "object") throw new Error("Input must be JSON");
  if (seen.has(value)) throw new Error("Input must be acyclic JSON");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result: Json[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!(index in value)) throw new Error("Input must not contain sparse arrays");
        result.push(copyJsonValue(value[index], seen));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Input must contain only plain JSON objects");
    const result: Record<string, Json> = Object.create(null) as Record<string, Json>;
    for (const [key, item] of Object.entries(value)) result[key] = copyJsonValue(item, seen);
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) throw new Error("Input must contain only enumerable string keys");
    return result;
  } finally {
    seen.delete(value);
  }
}

export function copyJsonWithLimit(value: unknown, maxBytes: number): Json {
  const copied = copyJsonValue(value, new Set());
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid JSON byte limit");
  if (Buffer.byteLength(JSON.stringify(copied), "utf8") > maxBytes) throw new Error(`Input exceeds ${String(maxBytes)} byte JSON limit`);
  return copied;
}

export function copyJson(value: unknown): Json {
  try { return copyJsonWithLimit(value, MAX_JSON_BYTES); }
  catch (error) {
    if (error instanceof Error && error.message === `Input exceeds ${String(MAX_JSON_BYTES)} byte JSON limit`) {
      throw new Error("Input exceeds 1 MiB JSON limit");
    }
    throw error;
  }
}

export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as { readonly [key: string]: Json };
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] as Json)}`).join(",")}}`;
}

export function freezeJson<T extends Json>(value: T): Readonly<T> {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const item of Array.isArray(value) ? value : Object.values(value)) freezeJson(item);
    Object.freeze(value);
  }
  return value;
}

const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function assertRunId(runId: string): void {
  if (!runIdPattern.test(runId)) throw new Error("Invalid run ID");
}

export interface ArtifactRef {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
}

export const artifactRefSchema = z.object({
  path: z.string().min(1).max(512).refine(
    (path) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").some((part) => part === "" || part === "." || part === ".."),
    "Invalid artifact path",
  ),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES),
  mediaType: z.string().min(1).max(128),
}).strict();

export const runManifestSchema = z.object({
  runId: z.string(),
  entry: z.url(),
  workspace: z.string().min(1),
  attempt: z.literal(1).default(1),
  runtime: z.object({
    provider: z.enum(["codex", "claude"]),
    executable: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  }).strict().default({ provider: "codex" }),
  allowEdits: z.boolean().default(false),
  hostLimits: z.object({
    maxAgentCalls: z.number().int().nonnegative().optional(),
    maxCommands: z.number().int().nonnegative().optional(),
    timeoutMs: z.number().int().positive().optional(),
    humanTimeoutMs: z.number().int().positive().optional(),
    maxStoredBytes: z.number().int().positive().optional(),
  }).strict().default({}),
  inputArtifact: artifactRefSchema,
  bundleArtifact: artifactRefSchema,
  fakeAgentResultsArtifact: artifactRefSchema.optional(),
  initializationCharges: z.object({ compilations: z.literal(1), inputValidations: z.literal(0) }).strict(),
}).strict();

export const startRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("start"),
    entry: z.url(),
    rawInput: z.unknown(),
    workspace: z.string().min(1),
    runtime: z.object({
      provider: z.enum(["codex", "claude"]), executable: z.string().min(1).optional(), model: z.string().min(1).optional(),
    }).strict(),
    allowEdits: z.boolean(),
    limits: z.object({
      maxAgentCalls: z.number().int().nonnegative().optional(), maxCommands: z.number().int().nonnegative().optional(),
      timeoutMs: z.number().int().positive().optional(), humanTimeoutMs: z.number().int().positive().optional(),
      maxStoredBytes: z.number().int().positive().optional(),
    }).strict(),
    crashAfterRunCreated: z.boolean().optional(),
    crashAt: z.enum(["after-human-reply", "after-approval-gate", "after-author-delivery", "after-approval-effect"]).optional(),
    fakeAgentResults: z.array(z.unknown()).max(100).optional(),
  }).strict(),
  z.object({
    mode: z.literal("resume"),
    workspace: z.string().min(1),
    runId: z.string(),
  }).strict(),
  z.object({
    mode: z.literal("cancel"),
    workspace: z.string().min(1),
    runId: z.string(),
    cancellationId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
    reason: z.string().max(64 * 1024),
  }).strict(),
  z.object({
    mode: z.literal("recovery"),
    workspace: z.string().min(1),
    runId: z.string(),
    submissionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  }).strict(),
]);

export type StartRequest = z.infer<typeof startRequestSchema>;

export const internalHumanReplySchema = z.object({
  requestId: z.string().regex(/^[0-9a-f]{64}$/),
  submissionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  decision: z.enum(["accept", "reject"]),
  value: z.json().optional(),
}).strict();

export type InternalHumanReply = z.infer<typeof internalHumanReplySchema>;

export interface JournalEvent {
  readonly version: 2;
  readonly runId: string;
  readonly sequence: number;
  readonly ownershipGeneration: 1;
  readonly timestamp: string;
  readonly type: "run.created" | "run.initialized" | "run.succeeded" | "run.failed";
  readonly data: Json;
  readonly previousHash: string;
  readonly hash: string;
}

export interface SerializedError {
  readonly code: string;
  readonly message: string;
}

export const errorCodeSchema = z.enum([
  "OUTCOME_UNKNOWN", "OWNER_UNVERIFIED", "CODE_CHANGED", "WORKSPACE_CHANGED", "HISTORY_MISMATCH", "EVIDENCE_CORRUPT",
  "STORAGE_UNAVAILABLE", "CLOCK_UNVERIFIED", "RECOVERY_LIMIT", "RUNTIME_MISSING", "RUNTIME_UNQUALIFIED", "AUTH_REQUIRED",
  "AUTH_CONFLICT", "AUTH_UNVERIFIED", "QUOTA_EXCEEDED", "CONFIG_UNVERIFIED", "STORAGE_UNSUPPORTED", "WORKSPACE_LIMIT",
  "INSTALLATION_MISMATCH", "INVALID_INPUT", "INVALID_OUTPUT", "INVALID_FLOW", "UNSUPPORTED_SCHEMA", "INVALID_AGENT_OUTPUT",
  "PROTOCOL_ERROR", "CONCURRENT_OPERATION", "UNAWAITED_OPERATION", "APPROVAL_SCOPE_EXCEEDED", "CHECK_FAILED",
  "APPROVAL_DENIED", "APPROVAL_STALE", "SPAWN_FAILED", "PROCESS_TERMINATED", "PERMISSION_DENIED", "RUNTIME_FAILED",
  "OUTPUT_LIMIT", "FILE_ERROR", "LIMIT_EXCEEDED", "TIMEOUT", "HUMAN_TIMEOUT", "WORKSPACE_BUSY", "CANCELLED", "FLOW_FAILED",
]);

export function serializeError(error: unknown): SerializedError {
  const parsed = error instanceof Error && "code" in error ? errorCodeSchema.safeParse(error.code) : undefined;
  return {
    code: parsed?.success ? parsed.data : "FLOW_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}
