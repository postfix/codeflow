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

export function copyJson(value: unknown): Json {
  const copied = copyJsonValue(value, new Set());
  if (Buffer.byteLength(JSON.stringify(copied), "utf8") > MAX_JSON_BYTES) throw new Error("Input exceeds 1 MiB JSON limit");
  return copied;
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
  inputArtifact: artifactRefSchema,
  bundleArtifact: artifactRefSchema,
  initializationCharges: z.object({ compilations: z.literal(1), inputValidations: z.literal(0) }).strict(),
}).strict();

export const startRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("start"),
    entry: z.url(),
    rawInput: z.unknown(),
    workspace: z.string().min(1),
    crashAfterRunCreated: z.boolean().optional(),
  }).strict(),
  z.object({
    mode: z.literal("resume"),
    workspace: z.string().min(1),
    runId: z.string(),
  }).strict(),
]);

export type StartRequest = z.infer<typeof startRequestSchema>;

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

export function serializeError(error: unknown): SerializedError {
  return {
    code: error instanceof z.ZodError ? "CONTRACT_INVALID" : "FLOW_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}
