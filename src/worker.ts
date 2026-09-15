import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, copyJson, freezeJson, type Json } from "./contracts.js";
import type { Flow, FlowContext } from "./sdk.js";

function unavailable(): never {
  throw new Error("This operation is not implemented in the minimal pure-flow slice");
}

export interface InitializedFlow {
  readonly definition: Flow<Json, Json>;
  readonly input: Readonly<Json>;
}

export async function initializeFlow(bundle: URL, rawInput: Json): Promise<InitializedFlow> {
  const loaded = await import(bundle.href) as { default?: Flow<Json, Json> };
  const definition = loaded.default;
  if (!definition || definition.kind !== "coding-flow/v2") throw new Error("Flow entry must default-export flow()");
  const input = copyJson(definition.input.parse(rawInput));
  if (canonicalJson(rawInput) !== canonicalJson(input)) throw new Error("Unsupported contract: input parsing changed its JSON value");
  return { definition, input: freezeJson(input) };
}

export async function runFlow(initialized: InitializedFlow, workspace: string): Promise<Json> {
  const { definition, input } = initialized;
  const context: FlowContext<Json> = {
    input,
    workspace,
    signal: new AbortController().signal,
    agent: async () => unavailable(),
    human: Object.freeze({}),
    command: async () => unavailable(),
    read: async (path) => readFile(join(workspace, path), "utf8"),
    phase: async (_name, body) => body(),
    skill: async () => unavailable(),
    check(condition, message) {
      if (!condition) throw new Error(message);
    },
    log() {},
  };
  const rawOutput = copyJson(await definition.run(context));
  const output = copyJson(definition.output.parse(rawOutput));
  if (canonicalJson(rawOutput) !== canonicalJson(output)) throw new Error("Unsupported contract: output parsing changed its JSON value");
  return output;
}
