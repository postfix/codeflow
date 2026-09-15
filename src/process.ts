import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, openSync, readSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ProcessIdentity {
  readonly groupId: number;
  readonly nonce: string;
}

export interface ProcessRequest {
  readonly attemptId: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly evidenceDirectory: string;
}

export interface Authorization {
  readonly attemptId: string;
  readonly nonce: string;
}

export interface RunnerReturn {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly error?: string;
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
}

export interface RegisteredProcess extends ProcessIdentity {
  readonly attemptId: string;
  readonly identity: ProcessIdentity;
  readonly request: ProcessRequest;
  readonly child: ChildProcess;
  authorized: boolean;
}

const MAX_RAW_BYTES = 64 * 1024 * 1024;
const MAX_TAIL_BYTES = 64 * 1024;

function runnerPath(): string {
  const current = fileURLToPath(import.meta.url);
  return extname(current) === ".ts"
    ? resolve(dirname(current), "../dist/src/runner.js")
    : join(dirname(current), "runner.js");
}

function runnerError(message: string): Error {
  return new Error(`Runner protocol error: ${message}`);
}

async function stopUnregisteredChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  await new Promise<void>((resolveExit) => {
    const onExit = (): void => resolveExit();
    child.once("exit", onExit);
    try {
      if (!child.kill("SIGKILL")) {
        child.off("exit", onExit);
        resolveExit();
      }
    } catch {
      child.off("exit", onExit);
      resolveExit();
    }
  });
}

function isRunnerReturn(value: unknown): value is RunnerReturn {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RunnerReturn>;
  return (candidate.exitCode === null || Number.isInteger(candidate.exitCode))
    && (candidate.signal === null || typeof candidate.signal === "string")
    && typeof candidate.stdout === "string" && Buffer.byteLength(candidate.stdout) <= 64 * 1024
    && typeof candidate.stderr === "string" && Buffer.byteLength(candidate.stderr) <= 64 * 1024
    && typeof candidate.truncated === "boolean"
    && (candidate.error === undefined || typeof candidate.error === "string")
    && (candidate.stdoutPath === undefined || typeof candidate.stdoutPath === "string")
    && (candidate.stderrPath === undefined || typeof candidate.stderrPath === "string");
}

export function readTail(descriptor: number, bytes: number, cutAtEnd: boolean): { readonly text: string; readonly omitted: boolean } {
  const length = Math.min(bytes, MAX_TAIL_BYTES + 3);
  const tail = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const count = readSync(descriptor, tail, read, length - read, bytes - length + read);
    if (count === 0) break;
    read += count;
  }
  let trailingIncomplete = 0;
  if (cutAtEnd) {
    while (trailingIncomplete < 3 && trailingIncomplete < read
      && (tail[read - trailingIncomplete - 1]! & 0xc0) === 0x80) trailingIncomplete += 1;
    const lead = tail[read - trailingIncomplete - 1];
    const expected = lead === undefined ? 0
      : lead >= 0xc2 && lead <= 0xdf ? 2
        : lead >= 0xe0 && lead <= 0xef ? 3
          : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
    const firstContinuation = tail[read - trailingIncomplete];
    let canonicalPrefix = firstContinuation === undefined || (firstContinuation >= 0x80 && firstContinuation <= 0xbf);
    if (firstContinuation !== undefined && lead === 0xe0) canonicalPrefix = firstContinuation >= 0xa0;
    if (firstContinuation !== undefined && lead === 0xed) canonicalPrefix = firstContinuation <= 0x9f;
    if (firstContinuation !== undefined && lead === 0xf0) canonicalPrefix = firstContinuation >= 0x90;
    if (firstContinuation !== undefined && lead === 0xf4) canonicalPrefix = firstContinuation <= 0x8f;
    if (expected > trailingIncomplete + 1 && canonicalPrefix) trailingIncomplete += 1;
    else trailingIncomplete = 0;
  }
  const decoded = new TextDecoder("utf-8").decode(tail.subarray(0, read - trailingIncomplete));
  let encodedBytes = Buffer.byteLength(decoded, "utf8");
  let start = 0;
  while (encodedBytes > MAX_TAIL_BYTES) {
    const width = (decoded.codePointAt(start) ?? 0) > 0xffff ? 2 : 1;
    encodedBytes -= Buffer.byteLength(decoded.slice(start, start + width), "utf8");
    start += width;
  }
  return { text: decoded.slice(start), omitted: bytes > length || start > 0 || trailingIncomplete > 0 };
}

function finalizeRunnerReturn(returned: RunnerReturn): RunnerReturn {
  if (!returned.stdoutPath || !returned.stderrPath) return returned;
  const flags = constants.O_RDWR | constants.O_NOFOLLOW;
  const stdoutDescriptor = openSync(returned.stdoutPath, flags);
  let stderrDescriptor: number | undefined;
  try {
    stderrDescriptor = openSync(returned.stderrPath, flags);
    const originalStdoutBytes = fstatSync(stdoutDescriptor).size;
    const originalStderrBytes = fstatSync(stderrDescriptor).size;
    let stdoutBytes = originalStdoutBytes;
    let stderrBytes = originalStderrBytes;
    let overflowed = false;
    if (stdoutBytes + stderrBytes > MAX_RAW_BYTES) {
      overflowed = true;
      if (stdoutBytes >= MAX_RAW_BYTES) {
        stdoutBytes = MAX_RAW_BYTES;
        stderrBytes = 0;
      } else {
        stderrBytes = MAX_RAW_BYTES - stdoutBytes;
      }
      ftruncateSync(stdoutDescriptor, stdoutBytes);
      ftruncateSync(stderrDescriptor, stderrBytes);
    }
    fsyncSync(stdoutDescriptor);
    fsyncSync(stderrDescriptor);
    const stdout = readTail(stdoutDescriptor, stdoutBytes, stdoutBytes < originalStdoutBytes);
    const stderr = readTail(stderrDescriptor, stderrBytes, stderrBytes < originalStderrBytes);
    return {
      ...returned,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: returned.truncated || overflowed || stdoutBytes > MAX_TAIL_BYTES || stderrBytes > MAX_TAIL_BYTES
        || stdout.omitted || stderr.omitted,
      ...(overflowed ? { error: "OUTPUT_LIMIT" } : {}),
    };
  } finally {
    closeSync(stdoutDescriptor);
    if (stderrDescriptor !== undefined) closeSync(stderrDescriptor);
  }
}

export class ProcessService {
  readonly #registered = new Set<RegisteredProcess>();
  readonly #starting = new Set<ChildProcess>();
  readonly #runnerFile: string;
  readonly #registrationTimeoutMs: number;
  #disposed = false;

  constructor(runnerFile = runnerPath(), registrationTimeoutMs = 5_000) {
    this.#runnerFile = runnerFile;
    this.#registrationTimeoutMs = registrationTimeoutMs;
  }

  async register(request: ProcessRequest): Promise<RegisteredProcess> {
    if (this.#disposed) throw new Error("Process service is disposed");
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(request.attemptId) || !request.executable
      || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new Error("Invalid process request");
    }
    const nonce = randomUUID();
    const child = fork(this.#runnerFile, [nonce], {
      detached: true,
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.#starting.add(child);
    const ready = await new Promise<{ readonly pid: number; readonly groupId: number; readonly nonce: string }>((resolveReady, reject) => {
      let settled = false;
      let timeout: NodeJS.Timeout;
      const cleanup = (): void => {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const fail = async (error: Error): Promise<void> => {
        if (settled) return;
        settled = true;
        cleanup();
        await stopUnregisteredChild(child);
        reject(error);
      };
      const onMessage = (message: unknown): void => {
        if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "ready") return;
        if (!("pid" in message) || typeof message.pid !== "number"
          || !("groupId" in message) || typeof message.groupId !== "number"
          || !("nonce" in message) || message.nonce !== nonce
          || message.pid !== child.pid || message.groupId !== child.pid) {
          void fail(runnerError("invalid registration handshake"));
          return;
        }
        settled = true;
        cleanup();
        resolveReady({ pid: message.pid, groupId: message.groupId, nonce });
      };
      const onError = (error: Error): void => { void fail(error); };
      const onExit = (): void => { void fail(runnerError("runner exited before registration")); };
      child.on("message", onMessage);
      child.once("error", onError);
      child.once("exit", onExit);
      timeout = setTimeout(() => { void fail(runnerError("registration timed out")); }, this.#registrationTimeoutMs);
    }).finally(() => this.#starting.delete(child));
    if (this.#disposed) {
      await stopUnregisteredChild(child);
      throw new Error("Process service is disposed");
    }
    const identity = Object.freeze({ groupId: ready.groupId, nonce });
    const registered: RegisteredProcess = {
      ...identity,
      attemptId: request.attemptId,
      identity,
      request: { ...request, args: [...request.args] },
      child,
      authorized: false,
    };
    this.#registered.add(registered);
    child.once("exit", () => this.#registered.delete(registered));
    return registered;
  }

  async authorizeTarget(registered: RegisteredProcess, authorization: Authorization): Promise<RunnerReturn> {
    if (this.#disposed) throw new Error("Process service is disposed");
    if (registered.authorized) throw new Error("Runner is already authorized");
    if (!this.#registered.has(registered)) throw new Error("Runner is not registered");
    if (authorization.attemptId !== registered.attemptId || authorization.nonce !== registered.nonce) {
      throw new Error("Authorization does not match registered runner");
    }
    registered.authorized = true;
    return new Promise<RunnerReturn>((resolveReturn, reject) => {
      let returned: RunnerReturn | undefined;
      const cleanup = (): void => {
        registered.child.off("message", onMessage);
        registered.child.off("error", onError);
        registered.child.off("exit", onExit);
      };
      const onMessage = (message: unknown): void => {
        if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "returned"
          || !("nonce" in message) || message.nonce !== registered.nonce || !("result" in message)
          || !isRunnerReturn(message.result)) return;
        returned = message.result;
      };
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const onExit = (): void => {
        cleanup();
        const result = returned;
        if (!result) {
          reject(runnerError("runner exited without return evidence"));
          return;
        }
        void this.assertGroupAbsent(registered.identity)
          .then(() => resolveReturn(finalizeRunnerReturn(result)))
          .catch(reject);
      };
      registered.child.on("message", onMessage);
      registered.child.once("error", onError);
      registered.child.once("exit", onExit);
      registered.child.send({
        type: "execute",
        nonce: authorization.nonce,
        attemptId: authorization.attemptId,
        executable: registered.request.executable,
        args: registered.request.args,
        cwd: registered.request.cwd,
        timeoutMs: registered.request.timeoutMs,
        evidenceDirectory: registered.request.evidenceDirectory,
      });
    });
  }

  async terminate(registered: RegisteredProcess, reason: string): Promise<void> {
    if (!this.#registered.has(registered) || registered.child.exitCode !== null || !registered.child.connected) return;
    registered.child.send({ type: "cancel", nonce: registered.nonce, reason });
    await new Promise<void>((resolveExit) => {
      const timeout = setTimeout(resolveExit, 3_500);
      registered.child.once("exit", () => { clearTimeout(timeout); resolveExit(); });
    });
  }

  async assertGroupAbsent(identity: ProcessIdentity, timeoutMs = 5_000): Promise<void> {
    if (!Number.isSafeInteger(identity.groupId) || identity.groupId <= 1 || !identity.nonce) {
      throw new Error("OWNER_UNVERIFIED");
    }
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        process.kill(-identity.groupId, 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
        throw new Error("OWNER_UNVERIFIED");
      }
      if (Date.now() >= deadline) throw new Error("OWNER_UNVERIFIED");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await Promise.all([
      ...[...this.#starting].map((child) => stopUnregisteredChild(child)),
      ...[...this.#registered].map((registered) => this.terminate(registered, "process service disposed")),
    ]);
  }
}
