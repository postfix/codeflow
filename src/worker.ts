import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  artifactRefSchema, canonicalJson, copyJson, copyJsonWithLimit, freezeJson, portableAgentContract, portableHumanContract,
  MAX_ARTIFACT_BYTES, MAX_JSON_BYTES, type Json,
} from "./contracts.js";
import { MAX_PROMPT_BYTES, readInstruction } from "./prompts.js";
import type {
  Agent, AgentOptions, ApprovalOptions, AskOptions, CommandOptions, CommandResult, Flow, FlowContext, Human, Limits,
  Presentation, Presented,
} from "./sdk.js";
import { readWorkspaceFile } from "./workspace.js";
import { approvalRejectionCode } from "./human.js";

const DEFAULT_LIMITS = {
  maxAgentCalls: 20, maxCommands: 100, timeoutMs: 30 * 60_000,
  humanTimeoutMs: 24 * 60 * 60_000, maxStoredBytes: 512 * 1024 * 1024,
} as const;

interface ResolvedLimits {
  readonly maxAgentCalls: number;
  readonly maxCommands: number;
  readonly timeoutMs: number;
  readonly humanTimeoutMs: number;
  readonly maxStoredBytes: number;
}
interface Budget { readonly limits: ResolvedLimits; agentCalls: number; commands: number }
interface ApprovalAuthority { readonly requestId: string; active: boolean; effectUsed: boolean }
interface Scope {
  readonly trace: readonly string[];
  readonly skillDepth: number;
  readonly budgets: readonly Budget[];
  structuralActive: boolean;
  approval?: ApprovalAuthority;
}

export interface WorkerOperations {
  agent?(request: Json): Promise<Json>;
  command?(request: Json): Promise<Json>;
  read?(request: Json): Promise<Json>;
  human?(request: Json): Promise<Json>;
  log?(message: string, data?: Json): void;
}
export interface InitializedFlow {
  readonly definition: Flow<Json, Json>;
  readonly input: Readonly<Json>;
  readonly instructionRoot?: string;
}

export class FlowRuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message = code) { super(message); this.code = code; }
}
const runtimeErrors = new WeakSet<Error>();
function runtimeError(code: string, message = code): FlowRuntimeError {
  const error = new FlowRuntimeError(code, message);
  runtimeErrors.add(error);
  return error;
}

function integerLimit(value: number | undefined, fallback: number, name: string, minimum = 0): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum) throw runtimeError("INVALID_LIMIT", `Invalid ${name}`);
  return result;
}
function resolveLimits(limits: Limits | undefined, parent?: ResolvedLimits): ResolvedLimits {
  const inherited = parent ?? DEFAULT_LIMITS;
  const resolved = {
    maxAgentCalls: integerLimit(limits?.maxAgentCalls, inherited.maxAgentCalls, "agent-call limit"),
    maxCommands: integerLimit(limits?.maxCommands, inherited.maxCommands, "command limit"),
    timeoutMs: integerLimit(limits?.timeoutMs, inherited.timeoutMs, "timeout"),
    humanTimeoutMs: integerLimit(limits?.humanTimeoutMs, inherited.humanTimeoutMs, "human timeout"),
    maxStoredBytes: integerLimit(limits?.maxStoredBytes, inherited.maxStoredBytes, "stored-byte limit"),
  };
  if (parent && Object.keys(resolved).some((key) => resolved[key as keyof ResolvedLimits] > parent[key as keyof ResolvedLimits])) {
    throw runtimeError("CHILD_LIMIT_WIDENED");
  }
  return resolved;
}
function exactJson<S extends z.ZodType>(
  schema: S,
  value: unknown,
  message: string,
  code: "INVALID_INPUT" | "INVALID_OUTPUT" | "INVALID_AGENT_OUTPUT",
): z.output<S> {
  const source = copyJson(value);
  let parsed: Json;
  try { parsed = copyJson(schema.parse(source)); }
  catch (error) {
    if (error instanceof z.ZodError) throw runtimeError(code, error.message);
    throw error;
  }
  if (canonicalJson(source) !== canonicalJson(parsed)) throw runtimeError(code, message);
  return parsed as z.output<S>;
}
function relativeWorkspacePath(path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw runtimeError("INVALID_WORKSPACE_PATH");
  }
  if (path === ".coding-flow" || path.startsWith(".coding-flow/")) throw runtimeError("PROTECTED_WORKSPACE_PATH");
  return path;
}
function timeout(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) throw runtimeError("INVALID_TIMEOUT");
  return Math.min(selected, maximum);
}
function unavailable(name: string): Promise<never> { return Promise.reject(runtimeError(`${name.toUpperCase()}_UNAVAILABLE`)); }
function handledRejection<T>(error: unknown): Promise<T> {
  const rejected = Promise.reject<T>(error);
  rejected.catch(() => undefined);
  return rejected;
}

export async function initializeFlow(bundle: URL, rawInput: Json, instructionRoot?: string): Promise<InitializedFlow> {
  const loaded = await import(bundle.href) as { default?: Flow<Json, Json> };
  const definition = loaded.default;
  if (!definition || definition.kind !== "coding-flow/v2") throw new Error("Flow entry must default-export flow()");
  const input = exactJson(definition.input, rawInput, "Unsupported contract: input parsing changed its JSON value", "INVALID_INPUT") as Json;
  return { definition, input: freezeJson(input), ...(instructionRoot ? { instructionRoot } : {}) };
}

export async function runFlow(
  initialized: InitializedFlow,
  workspace: string,
  operations: WorkerOperations = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<Json> {
  const storage = new AsyncLocalStorage<Scope>();
  const occurrences = new Map<string, number>();
  const pending = new Set<Promise<unknown>>();
  let active = false;
  let closed = false;
  let sticky: unknown;
  let operationOrdinal = 0;
  const rootLimits = resolveLimits(initialized.definition.limits);
  const instructionRoot = resolve(initialized.instructionRoot ?? workspace);
  const relativeInstructionRoot = relative(resolve(workspace), instructionRoot);
  const rootDisposable = new Set(initialized.definition.disposablePaths ?? []);
  const root: Scope = {
    trace: ["root"], skillDepth: 0,
    budgets: [{ limits: rootLimits, agentCalls: 0, commands: 0 }], structuralActive: false,
  };
  const remember = (error: unknown): void => {
    if (error instanceof FlowRuntimeError && runtimeErrors.has(error)
      && ["CHECK_FAILED", "APPROVAL_DENIED", "APPROVAL_STALE"].includes(error.code)) return;
    sticky ??= error;
  };
  const reject = <T>(error: unknown): Promise<T> => { remember(error); return handledRejection(error); };
  const current = (): Scope => storage.getStore() ?? root;
  const trace = (kind: string): readonly Json[] => [...current().trace, kind, ++operationOrdinal];
  const reserve = (kind: "agent" | "command"): void => {
    for (const budget of current().budgets) {
      const used = kind === "agent" ? budget.agentCalls : budget.commands;
      const maximum = kind === "agent" ? budget.limits.maxAgentCalls : budget.limits.maxCommands;
      if (used >= maximum) throw runtimeError(kind === "agent" ? "AGENT_LIMIT" : "COMMAND_LIMIT");
    }
    for (const budget of current().budgets) {
      if (kind === "agent") budget.agentCalls += 1;
      else budget.commands += 1;
    }
  };
  const invoke = <T>(body: () => Promise<T>): Promise<T> => {
    if (sticky !== undefined) return handledRejection(sticky);
    if (closed) return handledRejection(runtimeError("OPERATION_CLOSED"));
    if (active || current().structuralActive) {
      return reject(runtimeError("CONCURRENT_OPERATION"));
    }
    active = true;
    const issued = Promise.resolve().then(body);
    pending.add(issued);
    void issued.then(
      () => { active = false; pending.delete(issued); },
      (error) => { active = false; pending.delete(issued); remember(error); },
    );
    return issued;
  };
  const enter = <T>(kind: "phase" | "skill" | "approval", name: string, body: (scope: Scope) => Promise<T>): Promise<T> => {
    if (sticky !== undefined) return handledRejection(sticky);
    if (!/^[a-z0-9-]{1,64}$/.test(name)) return reject(runtimeError("INVALID_SCOPE_NAME"));
    const parent = current();
    if (active || parent.structuralActive) return reject(runtimeError("CONCURRENT_OPERATION"));
    parent.structuralActive = true;
    const key = `${parent.trace.join("/")}/${kind}:${name}`;
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    const child: Scope = {
      trace: [...parent.trace, `${kind}:${name}#${occurrence}`],
      skillDepth: parent.skillDepth + (kind === "skill" ? 1 : 0), budgets: parent.budgets, structuralActive: false,
      ...(parent.approval ? { approval: parent.approval } : {}),
    };
    const issued = Promise.resolve()
      .then(() => storage.run(child, () => body(child)))
      .finally(() => { parent.structuralActive = false; });
    pending.add(issued);
    void issued.then(
      () => pending.delete(issued),
      (error) => { pending.delete(issued); remember(error); },
    );
    return issued;
  };
  const approvalEffect = (): string | undefined => {
    const { approval } = current();
    if (!approval) return undefined;
    if (!approval.active) throw runtimeError("APPROVAL_SCOPE_EXPIRED");
    if (approval.effectUsed) throw runtimeError("APPROVAL_ALREADY_USED");
    approval.effectUsed = true;
    return approval.requestId;
  };

  const human: Human = Object.freeze({
    present(content: Presentation): Promise<Presented> {
      return invoke(async () => z.object({ id: z.string(), hash: z.string() }).strict().parse(
        await (operations.human?.(copyJson({ kind: "present", trace: trace("human-present"), presentation: content })) ?? unavailable("human")),
      ));
    },
    ask<S extends z.ZodType>(options: AskOptions<S>): Promise<z.output<S>> {
      return invoke(async () => {
        if (!options || typeof options.question !== "string") throw runtimeError("INVALID_HUMAN_REQUEST");
        const result = await (operations.human?.(copyJson({
          kind: "ask", trace: trace("human-ask"), question: options.question, presentation: options.presentation,
          schema: portableHumanContract(options.output), timeoutMs: current().budgets.at(-1)!.limits.humanTimeoutMs,
        })) ?? unavailable("human"));
        return exactJson(options.output, result, "Unsupported contract: human reply parsing changed its JSON value", "INVALID_INPUT");
      });
    },
    approve<P extends Json, T>(options: ApprovalOptions<P>, execute: (approvedAction: Readonly<P>) => Promise<T>): Promise<T> {
      return enter("approval", "human", async (scope) => {
        if (!options || typeof options.title !== "string" || typeof execute !== "function") throw runtimeError("INVALID_HUMAN_REQUEST");
        const action = freezeJson(copyJson(options.action));
        const request = copyJson({
            kind: "approve", trace: [...scope.trace, "human-approve"], title: options.title,
            presentation: options.presentation, action, watch: [...(options.watch ?? [])],
            timeoutMs: scope.budgets.at(-1)!.limits.humanTimeoutMs,
          });
        let result: Json;
        try { result = await (operations.human?.(request) ?? unavailable("human")); }
        catch (error) {
          const code = approvalRejectionCode(error, request);
          if (code) throw runtimeError(code);
          throw error;
        }
        const response = z.object({ requestId: z.string(), action: z.json() }).strict().parse(result);
        if (canonicalJson(copyJson(response.action)) !== canonicalJson(action)) throw runtimeError("APPROVAL_SCOPE_MISMATCH");
        const approval: ApprovalAuthority = { requestId: response.requestId, active: true, effectUsed: false };
        scope.approval = approval;
        try { return await execute(action as Readonly<P>); }
        finally { approval.active = false; }
      });
    },
  });

  const contextFor = <I extends Json>(input: Readonly<I>): FlowContext<I> => {
    const agent = ((options: AgentOptions & { readonly output?: z.ZodType }) => invoke(async () => {
        reserve("agent");
        if (!options || !/^[a-z0-9-]{1,64}$/.test(options.name) || typeof options.prompt !== "string") throw runtimeError("INVALID_AGENT_REQUEST");
        if (options.access !== undefined && options.access !== "read" && options.access !== "write") throw runtimeError("INVALID_AGENT_REQUEST");
        const instructionPaths = options.instructions ?? [];
        if (instructionPaths.length > 64) throw runtimeError("INSTRUCTION_LIMIT");
        const snapshots: { readonly path: string; readonly content: string; readonly sha256: string }[] = [];
        if (relativeInstructionRoot === ".." || relativeInstructionRoot.startsWith(`..${sep}`) || isAbsolute(relativeInstructionRoot)) {
          throw runtimeError("INSTRUCTION_ROOT_OUTSIDE_WORKSPACE");
        }
        let instructionBytes = 0;
        for (const path of instructionPaths) {
          const normalized = relativeWorkspacePath(path);
          const content = await readInstruction(instructionRoot, normalized);
          instructionBytes += Buffer.byteLength(content, "utf8");
          if (instructionBytes > MAX_PROMPT_BYTES) throw runtimeError("INSTRUCTION_LIMIT");
          snapshots.push({ path: normalized, content, sha256: createHash("sha256").update(content).digest("hex") });
        }
        const evidence = (options.evidence ?? []).map((item) => artifactRefSchema.parse(item));
        if (evidence.length > 64 || evidence.reduce((bytes, item) => bytes + item.bytes, 0) > MAX_ARTIFACT_BYTES) throw runtimeError("EVIDENCE_LIMIT");
        const evidencePreamble = evidence.length === 0 ? [] : [
          `Evidence artifacts:\n${evidence.map((item) => `- ${item.path} (${item.sha256})`).join("\n")}`,
        ];
        const framedPrompt = [...snapshots.map(({ content }) => content), ...evidencePreamble, options.prompt].join("\n\n");
        if (Buffer.byteLength(framedPrompt, "utf8") > MAX_PROMPT_BYTES) throw runtimeError("PROMPT_LIMIT");
        const outputContract = options.output ? portableAgentContract(options.output) : "text/v1";
        const approvalRequestId = approvalEffect();
        const request = copyJsonWithLimit({
          trace: trace("agent"), schema: outputContract,
          name: options.name, prompt: framedPrompt, access: options.access ?? "read", instructions: snapshots, evidence,
          timeoutMs: timeout(options.timeoutMs, 600_000, current().budgets.at(-1)!.limits.timeoutMs),
          ...(approvalRequestId ? { approvalRequestId } : {}),
        }, MAX_ARTIFACT_BYTES);
        const result = await (operations.agent?.(request) ?? unavailable("agent"));
        if (!options.output) {
          if (typeof result !== "string") throw runtimeError("INVALID_AGENT_OUTPUT");
          return result;
        }
        return exactJson(options.output, result, "Unsupported contract: agent output parsing changed its JSON value", "INVALID_AGENT_OUTPUT");
    })) as Agent;

    return {
      input, workspace, signal, agent, human,
      command(executable: string, args: readonly string[] = [], options: CommandOptions = {}): Promise<CommandResult> {
        return invoke(async () => {
          reserve("command");
          if (!executable || !args.every((arg) => typeof arg === "string")) throw runtimeError("INVALID_COMMAND");
          const cwd = options.cwd === undefined || options.cwd === "." ? "." : relativeWorkspacePath(options.cwd);
          if (options.stdin !== undefined && Buffer.byteLength(options.stdin, "utf8") > MAX_JSON_BYTES) throw runtimeError("STDIN_LIMIT");
          const approvalRequestId = approvalEffect();
          const request = copyJsonWithLimit({
            trace: trace("command"), schema: "command-result/v1", executable, args: [...args], cwd,
            stdin: options.stdin ?? "", timeoutMs: timeout(options.timeoutMs, 120_000, current().budgets.at(-1)!.limits.timeoutMs),
            ...(approvalRequestId ? { approvalRequestId } : {}),
          }, MAX_ARTIFACT_BYTES);
          const result = await (operations.command?.(request) ?? unavailable("command"));
          return z.object({
            exitCode: z.number().int(), stdout: z.string(), stderr: z.string(), truncated: z.boolean(),
            stdoutArtifact: artifactRefSchema, stderrArtifact: artifactRefSchema,
          }).strict().parse(result);
        });
      },
      read(path: string): Promise<string> {
        return invoke(async () => {
          const normalized = relativeWorkspacePath(path);
          const request = copyJson({ trace: trace("read"), schema: "utf8/v1", path: normalized });
          const result = operations.read ? await operations.read(request) : await readWorkspaceFile(workspace, normalized);
          if (typeof result !== "string") throw runtimeError("INVALID_READ_OUTCOME");
          if (Buffer.byteLength(result, "utf8") > MAX_JSON_BYTES) throw runtimeError("READ_LIMIT");
          return result;
        });
      },
      phase<T>(name: string, body: () => Promise<T>): Promise<T> { return enter("phase", name, async () => body()); },
      skill<A extends Json, B extends Json>(child: Flow<A, B>, childInput: A): Promise<B> {
        return enter("skill", child.name, async (scope) => {
          if (scope.skillDepth > 8) throw runtimeError("SKILL_DEPTH");
          if (!child || child.kind !== "coding-flow/v2") throw runtimeError("INVALID_SKILL");
          if ((child.disposablePaths ?? []).some((path) => !rootDisposable.has(path))) throw runtimeError("CHILD_DISPOSABLE_PATH_WIDENED");
          const childLimits = resolveLimits(child.limits, scope.budgets.at(-1)!.limits);
          const budget: Budget = { limits: childLimits, agentCalls: 0, commands: 0 };
          const nested: Scope = { ...scope, budgets: [...scope.budgets, budget] };
          const validatedInput = freezeJson(exactJson(
            child.input, childInput, "Unsupported contract: child input parsing changed its JSON value", "INVALID_INPUT",
          ) as Json) as Readonly<A>;
          try {
            return await storage.run(nested, async () => exactJson(
              child.output, await child.run(contextFor(validatedInput)),
              "Unsupported contract: child output parsing changed its JSON value", "INVALID_OUTPUT",
            ) as B);
          } catch (error) { remember(error); throw error; }
        });
      },
      check(condition: boolean, message: string): void {
        if (!condition) { const error = runtimeError("CHECK_FAILED", message); remember(error); throw error; }
      },
      log(message: string, data?: Json): void {
        try {
          if (!message || Buffer.byteLength(message, "utf8") > 64 * 1024) throw runtimeError("LOG_LIMIT");
          const copied = data === undefined ? undefined : copyJson(data);
          operations.log?.(message, copied);
        } catch (error) { remember(error); throw error; }
      },
    };
  };

  let rawOutput: unknown;
  try { rawOutput = await storage.run(root, () => initialized.definition.run(contextFor(initialized.input))); }
  finally { closed = true; }
  if (pending.size > 0) { remember(runtimeError("UNAWAITED_OPERATION")); await Promise.allSettled([...pending]); }
  if (sticky !== undefined) throw sticky;
  return exactJson(
    initialized.definition.output, rawOutput, "Unsupported contract: output parsing changed its JSON value", "INVALID_OUTPUT",
  ) as Json;
}
