import { z } from "zod";
import { assertPortableContract, type Json } from "./contracts.js";
import { formatPrompt } from "./prompts.js";

export { z } from "zod";
export type { ArtifactRef, Json } from "./contracts.js";
export type Provider = "codex" | "claude";
export type Access = "read" | "write";

export interface Limits {
  readonly maxAgentCalls?: number;
  readonly maxCommands?: number;
  readonly timeoutMs?: number;
  readonly humanTimeoutMs?: number;
  readonly maxStoredBytes?: number;
}

export interface FlowContext<I extends Json> {
  readonly input: Readonly<I>;
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly agent: (...args: readonly unknown[]) => Promise<unknown>;
  readonly human: Readonly<Record<string, never>>;
  command(executable: string, args?: readonly string[]): Promise<unknown>;
  read(path: string): Promise<string>;
  phase<T>(name: string, body: () => Promise<T>): Promise<T>;
  skill<A extends Json, B extends Json>(child: Flow<A, B>, input: A): Promise<B>;
  check(condition: boolean, message: string): void;
  log(message: string, data?: Json): void;
}

export interface FlowDefinition<I extends Json, O extends Json> {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType<I, I>;
  readonly output: z.ZodType<O, O>;
  readonly limits?: Limits;
  readonly disposablePaths?: readonly string[];
  readonly run: (context: FlowContext<I>) => Promise<O>;
}

export interface Flow<I extends Json, O extends Json> extends FlowDefinition<I, O> {
  readonly kind: "coding-flow/v2";
}

type IsJsonSchema<S extends z.ZodType> = z.input<S> extends Json
  ? z.output<S> extends Json
    ? [z.input<S>] extends [z.output<S>]
      ? [z.output<S>] extends [z.input<S>] ? true : false
      : false
    : false
  : false;

type SchemaJson<S extends z.ZodType> = Extract<z.output<S>, Json>;

export function flow<const IS extends z.ZodType, const OS extends z.ZodType>(
  definition: {
    readonly name: string;
    readonly description: string;
    readonly input: IS;
    readonly output: OS;
    readonly limits?: Limits;
    readonly disposablePaths?: readonly string[];
    readonly run: (context: FlowContext<SchemaJson<NoInfer<IS>>>) => Promise<SchemaJson<NoInfer<OS>>>;
  } & (IsJsonSchema<IS> extends true ? unknown : never) & (IsJsonSchema<OS> extends true ? unknown : never),
): Flow<SchemaJson<IS>, SchemaJson<OS>> {
  if (!/^[a-z0-9-]{1,64}$/.test(definition.name)) throw new Error("Invalid flow name");
  if (!definition.description) throw new Error("Flow description is required");
  assertPortableContract(definition.input);
  assertPortableContract(definition.output);
  return Object.freeze({ ...definition, kind: "coding-flow/v2" as const }) as unknown as Flow<SchemaJson<IS>, SchemaJson<OS>>;
}

export function prompt(strings: TemplateStringsArray, ...values: readonly unknown[]): string {
  return formatPrompt(strings, ...values);
}
