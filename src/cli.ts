import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readBoundedFile } from "./artifacts.js";
import { buildFlow } from "./build.js";
import { claudeAdapter } from "./adapters/claude.js";
import { codexAdapter } from "./adapters/codex.js";
import type { Provider, Limits } from "./sdk.js";
import {
  inspectRecovery, listRuns, openRun, resumeRun, startFlow,
  type HumanReply, type ReplyReceipt, type RunBoundary, type RuntimeConfig,
} from "./host.js";
import { installWrapper, type WrapperHost } from "./install.js";
import { acquireOwnership } from "./ownership.js";
import { ProcessService } from "./process.js";

const MAX_JSON_BYTES = 1024 * 1024;
const VALUE_FLAGS = new Set([
  "provider", "input", "workspace", "executable", "model", "wait-ms", "reason", "host",
  "max-agent-calls", "max-commands", "timeout-ms", "human-timeout-ms", "max-stored-bytes",
]);
const BOOLEAN_FLAGS = new Set(["allow-edits"]);

interface Arguments { readonly positionals: readonly string[]; readonly flags: ReadonlyMap<string, string | true> }

function parseArguments(argv: readonly string[], allowed: readonly string[]): Arguments {
  const permitted = new Set(allowed);
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) { positionals.push(token); continue; }
    const name = token.slice(2);
    if (!permitted.has(name) || (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name))) throw new Error(`Unknown flag --${name}`);
    if (flags.has(name)) throw new Error(`Duplicate flag --${name}`);
    if (BOOLEAN_FLAGS.has(name)) { flags.set(name, true); continue; }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`Flag --${name} requires a value`);
    flags.set(name, value);
  }
  return { positionals, flags };
}

function stringFlag(args: Arguments, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function integerFlag(args: Arguments, name: string, minimum: number): number | undefined {
  const raw = stringFlag(args, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < minimum) throw new Error(`Invalid --${name}`);
  return Number(raw);
}

function workspace(args: Arguments): string { return resolve(stringFlag(args, "workspace") ?? process.cwd()); }

function waitMs(args: Arguments, fallback: number): number {
  const value = integerFlag(args, "wait-ms", 0) ?? fallback;
  if (value > 30_000) throw new Error("--wait-ms cannot exceed 30000");
  return value;
}

async function stdinBytes(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_JSON_BYTES) throw new Error("stdin exceeds 1 MiB JSON limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

async function readJson(location: string): Promise<unknown> {
  const bytes = location === "-" ? await stdinBytes() : await readBoundedFile(resolve(location), MAX_JSON_BYTES);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`Invalid JSON in ${location === "-" ? "stdin" : location}`); }
}

function one(args: Arguments, label: string): string {
  if (args.positionals.length !== 1) throw new Error(`${label} requires exactly one argument`);
  return args.positionals[0]!;
}

function exitForBoundary(boundary: RunBoundary): number {
  switch (boundary.status) {
    case "succeeded": return 0;
    case "waiting-for-human": return 10;
    case "starting": case "running": case "recovering": return 11;
    case "interrupted": case "blocked": return 12;
    case "timed-out": return 4;
    case "cancelled": return 130;
    case "failed": return 1;
  }
}

function exitForReceipt(receipt: ReplyReceipt): number {
  return receipt.status === "accepted" || receipt.status === "already-applied" ? 0
    : receipt.status === "uncertain" ? 12 : 2;
}

function limits(args: Arguments): Limits {
  const values = {
    maxAgentCalls: integerFlag(args, "max-agent-calls", 0),
    maxCommands: integerFlag(args, "max-commands", 0),
    timeoutMs: integerFlag(args, "timeout-ms", 1),
    humanTimeoutMs: integerFlag(args, "human-timeout-ms", 1),
    maxStoredBytes: integerFlag(args, "max-stored-bytes", 1),
  };
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, number] => entry[1] !== undefined));
}

async function pruneRuns(root: string, runIds: readonly string[]): Promise<readonly string[]> {
  if (runIds.length === 0 || new Set(runIds).size !== runIds.length) throw new Error("prune requires distinct run IDs");
  const ownership = await acquireOwnership(root);
  try {
    for (const runId of runIds) {
      const boundary = await inspectRecovery(root, runId);
      if (boundary.status !== "succeeded" && boundary.status !== "failed"
        && boundary.status !== "cancelled" && boundary.status !== "timed-out") {
        throw new Error(`Run ${runId} is not terminal`);
      }
    }
    for (const runId of runIds) await rm(join(root, ".coding-flow", "runs", runId), { recursive: true });
    return runIds;
  } finally { ownership.release(); }
}

export async function executeCommand(command: string, argv: readonly string[]): Promise<{ readonly value: unknown; readonly exitCode: number }> {
  if (command === "run") {
    const args = parseArguments(argv, [
      "provider", "input", "workspace", "executable", "model", "allow-edits", "wait-ms",
      "max-agent-calls", "max-commands", "timeout-ms", "human-timeout-ms", "max-stored-bytes",
    ]);
    const entry = one(args, "run");
    const provider = stringFlag(args, "provider");
    const input = stringFlag(args, "input");
    if ((provider !== "codex" && provider !== "claude") || !input) throw new Error("run requires --provider codex|claude and --input <file>|-");
    const root = workspace(args);
    const executable = stringFlag(args, "executable");
    const model = stringFlag(args, "model");
    if (!model) throw new Error("CONFIG_UNVERIFIED: run requires --model because native defaults are not qualified");
    const runtime: RuntimeConfig = {
      provider,
      ...(executable ? { executable } : {}),
      model,
    };
    const started = await startFlow(pathToFileURL(isAbsolute(entry) ? entry : resolve(root, entry)), await readJson(input), {
      workspace: root, runtime, allowEdits: args.flags.has("allow-edits"), limits: limits(args),
    });
    const boundary = await started.wait(waitMs(args, 30_000));
    return { value: boundary, exitCode: exitForBoundary(boundary) };
  }
  if (command === "status" || command === "resume") {
    const args = parseArguments(argv, ["workspace", "wait-ms"]);
    const runId = one(args, command);
    const handle = command === "resume" ? await resumeRun(workspace(args), runId) : await openRun(workspace(args), runId);
    const boundary = await handle.wait(waitMs(args, command === "resume" ? 30_000 : 0));
    return { value: boundary, exitCode: exitForBoundary(boundary) };
  }
  if (command === "recovery") {
    const args = parseArguments(argv, ["workspace"]);
    const boundary = await inspectRecovery(workspace(args), one(args, "recovery"));
    return { value: boundary, exitCode: exitForBoundary(boundary) };
  }
  if (command === "list") {
    const args = parseArguments(argv, ["workspace"]);
    if (args.positionals.length !== 0) throw new Error("list accepts no arguments");
    return { value: await listRuns(workspace(args)), exitCode: 0 };
  }
  if (command === "respond") {
    const args = parseArguments(argv, ["workspace", "input"]);
    const input = stringFlag(args, "input");
    if (!input) throw new Error("respond requires --input <file>|-");
    const receipt = await (await openRun(workspace(args), one(args, "respond"))).respond(await readJson(input) as HumanReply);
    return { value: receipt, exitCode: exitForReceipt(receipt) };
  }
  if (command === "cancel") {
    const args = parseArguments(argv, ["workspace", "reason"]);
    const boundary = await (await openRun(workspace(args), one(args, "cancel"))).cancel(stringFlag(args, "reason"));
    return { value: boundary, exitCode: exitForBoundary(boundary) };
  }
  if (command === "install") {
    const args = parseArguments(argv, ["workspace", "host"]);
    const host = stringFlag(args, "host");
    if (host !== "codex" && host !== "claude") throw new Error("install requires --host codex|claude");
    const target = await installWrapper(one(args, "install"), host as WrapperHost, workspace(args));
    return { value: { target }, exitCode: 0 };
  }
  if (command === "prune") {
    const args = parseArguments(argv, ["workspace"]);
    return { value: { pruned: await pruneRuns(workspace(args), args.positionals) }, exitCode: 0 };
  }
  if (command === "doctor") {
    const args = parseArguments(argv, ["provider", "workspace", "executable"]);
    if (args.positionals.length !== 0) throw new Error("doctor accepts no arguments");
    const provider = stringFlag(args, "provider") as Provider | undefined;
    if (provider !== "codex" && provider !== "claude") throw new Error("doctor requires --provider codex|claude");
    const directory = await mkdtemp(join(tmpdir(), `coding-flow-doctor-${randomUUID()}-`));
    const service = new ProcessService();
    let ownership: Awaited<ReturnType<typeof acquireOwnership>> | undefined;
    try {
      ownership = await acquireOwnership(workspace(args));
      const qualification = { operationDirectory: directory, ...(stringFlag(args, "executable") ? { executable: stringFlag(args, "executable") } : {}) };
      const adapter = provider === "codex" ? codexAdapter(service, qualification) : claudeAdapter(service, qualification);
      const status = await adapter.status(new AbortController().signal);
      const nodeQualified = process.version === "v24.19.0";
      return { value: { node: process.version, nodeQualified, locking: true, status }, exitCode: status.qualified && nodeQualified ? 0 : 3 };
    } finally { ownership?.release(); await service.dispose(); await rm(directory, { recursive: true, force: true }); }
  }
  if (command === "inspect") {
    const args = parseArguments(argv, ["workspace"]);
    const entry = one(args, "inspect");
    const root = workspace(args);
    const url = pathToFileURL(isAbsolute(entry) ? entry : resolve(root, entry));
    const directory = await mkdtemp(join(tmpdir(), `coding-flow-inspect-${randomUUID()}-`));
    const service = new ProcessService();
    try {
      const built = await buildFlow(url, directory, root);
      const attemptId = `inspect-${randomUUID()}`;
      const script = `
        const { z } = await import(process.argv[2]);
        const loaded = await import(process.argv[1]);
        const flow = loaded.default;
        if (!flow || flow.kind !== "coding-flow/v2") throw new Error("Entry does not export a Coding Flow");
        process.stdout.write(JSON.stringify({ name: flow.name, description: flow.description,
          input: z.toJSONSchema(flow.input, { target: "draft-7" }),
          output: z.toJSONSchema(flow.output, { target: "draft-7" }), limits: flow.limits ?? {} }));
      `;
      const registered = await service.register({
        attemptId, executable: process.execPath, args: [
          "--input-type=module", "--eval", script, built.url.href,
          pathToFileURL(createRequire(import.meta.url).resolve("zod")).href,
        ],
        cwd: root, timeoutMs: 60_000, evidenceDirectory: directory,
      });
      const returned = await service.authorizeTarget(registered, { attemptId, nonce: registered.nonce }, MAX_JSON_BYTES);
      if (returned.exitCode !== 0 || returned.error || !returned.stdoutPath) throw new Error("Flow inspection failed");
      const value = await readJson(returned.stdoutPath);
      return { value, exitCode: 0 };
    } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }); }
  }
  throw new Error(`Unknown command ${command}`);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (!command) throw new Error("A command is required");
    const result = await executeCommand(command, rest);
    process.stdout.write(`${JSON.stringify(result.value)}\n`);
    return result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n`);
    process.stdout.write(`${JSON.stringify({ error: { message } })}\n`);
    return /RUNTIME_|AUTH_|CONFIG_/.test(message) ? 3 : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
