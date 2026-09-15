import { fork } from "node:child_process";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { verifyArtifact } from "./artifacts.js";
import {
  artifactRefSchema,
  assertRunId,
  copyJson,
  type ArtifactRef,
  type Json,
  type SerializedError,
  type StartRequest,
} from "./contracts.js";
import { readVerifiedEvents } from "./journal.js";
import { readTestControl } from "./testing.js";

const succeededDataSchema = z.object({ outputArtifact: artifactRefSchema }).strict();
const failedDataSchema = z.object({ errorArtifact: artifactRefSchema }).strict();
const serializedErrorSchema = z.object({ code: z.string(), message: z.string() }).strict();

export type RunBoundary =
  | { readonly runId: string; readonly status: "starting" }
  | { readonly runId: string; readonly status: "succeeded"; readonly output: Json; readonly outputArtifact: ArtifactRef }
  | { readonly runId: string; readonly status: "failed"; readonly error: SerializedError };

export interface RunOptions {
  readonly workspace: string;
}

export interface RunHandle {
  readonly runId: string;
  wait(timeoutMs?: number): Promise<RunBoundary>;
}

function supervisorPath(): string {
  const current = fileURLToPath(import.meta.url);
  return extname(current) === ".ts"
    ? resolve(dirname(current), "../dist/src/supervisor.js")
    : join(dirname(current), "supervisor.js");
}

async function readArtifactJson(runDirectory: string, artifact: ArtifactRef): Promise<Json> {
  try {
    const bytes = await verifyArtifact(runDirectory, artifact);
    return copyJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    throw new Error("Corrupt journal");
  }
}

function handle(workspace: string, runId: string): RunHandle {
  return {
    runId,
    async wait(timeoutMs = 30_000): Promise<RunBoundary> {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        try {
          const events = await readVerifiedEvents(workspace, runId);
          const terminal = events.at(-1);
          if (terminal?.type === "run.succeeded") {
            const data = succeededDataSchema.safeParse(terminal.data);
            if (!data.success) throw new Error("Corrupt journal");
            const runDirectory = resolve(workspace, ".coding-flow", "runs", runId);
            const output = await readArtifactJson(runDirectory, data.data.outputArtifact);
            return { runId, status: "succeeded", output, outputArtifact: data.data.outputArtifact };
          }
          if (terminal?.type === "run.failed") {
            const data = failedDataSchema.safeParse(terminal.data);
            if (!data.success) throw new Error("Corrupt journal");
            const runDirectory = resolve(workspace, ".coding-flow", "runs", runId);
            const error = serializedErrorSchema.safeParse(await readArtifactJson(runDirectory, data.data.errorArtifact));
            if (!error.success) throw new Error("Corrupt journal");
            return { runId, status: "failed", error: error.data };
          }
        } catch (error) {
          const retryable = error instanceof Error && (
            ("code" in error && error.code === "ENOENT")
            || error.message === "File changed while reading"
          );
          if (!retryable) throw error;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for run ${runId}`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
    },
  };
}

async function launchSupervisor(request: StartRequest): Promise<RunHandle> {
  const child = fork(supervisorPath(), [], {
    detached: true,
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  const onStderr = (chunk: string): void => { stderr += chunk; };
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", onStderr);
  const runId = await new Promise<string>((resolveRun, reject) => {
    const cleanup = (): void => {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stderr?.off("data", onStderr);
      child.stderr?.destroy();
      child.unref();
    };
    const onMessage = (handshake: unknown): void => {
      cleanup();
      if (typeof handshake !== "object" || handshake === null || !("runId" in handshake) || typeof handshake.runId !== "string") {
        reject(new Error("Invalid supervisor handshake"));
        return;
      }
      resolveRun(handshake.runId);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Supervisor exited ${String(code)} before startup completed: ${stderr}`));
    };
    child.once("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
    child.send(request);
  });
  return handle(request.workspace, runId);
}

export async function startFlow(entry: URL, rawInput: unknown, options: RunOptions): Promise<RunHandle> {
  const control = readTestControl(options);
  const request: StartRequest = {
    mode: "start",
    entry: entry.href,
    rawInput: copyJson(rawInput),
    workspace: resolve(options.workspace),
    ...(control?.crashAfterRunCreated === true ? { crashAfterRunCreated: true } : {}),
  };
  return launchSupervisor(request);
}

export function openRun(workspace: string, runId: string): RunHandle {
  assertRunId(runId);
  return handle(resolve(workspace), runId);
}

export async function resumeRun(workspace: string, runId: string): Promise<RunHandle> {
  assertRunId(runId);
  return launchSupervisor({ mode: "resume", workspace: resolve(workspace), runId });
}
