import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { join } from "node:path";

const MAX_RAW_BYTES = 64 * 1024 * 1024;
const nonce = process.argv[2];
if (!nonce || !process.send) throw new Error("Runner requires private IPC");

let target: ChildProcess | undefined;
let used = false;
let cleaning = false;
let finished = false;
let returnSent = false;
let killGroupAfterReturn = false;
let exitCode: number | null = null;
let signal: NodeJS.Signals | null = null;
let error: string | undefined;
let truncated = false;
let outputPoll: NodeJS.Timeout | undefined;
let stdoutDescriptor: number | undefined;
let stderrDescriptor: number | undefined;
let stdoutPath: string | undefined;
let stderrPath: string | undefined;

function finish(): void {
  if (finished) return;
  finished = true;
  const result = {
    exitCode,
    signal,
    stdout: "",
    stderr: "",
    truncated,
    ...(stdoutPath ? { stdoutPath } : {}),
    ...(stderrPath ? { stderrPath } : {}),
    ...(error ? { error } : {}),
  };
  const complete = (): void => {
    if (returnSent) return;
    returnSent = true;
    if (process.connected) process.disconnect();
    if (!target) process.exit(0);
    else if (killGroupAfterReturn) killGroup();
    else cleanup("TARGET_EXITED");
  };
  if (process.connected) process.send?.({ type: "returned", nonce, result }, complete);
  else complete();
}

function killGroup(): void {
  try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(0); }
}

function killTargetForFinalization(): void {
  killGroupAfterReturn = true;
  if (target?.exitCode === null && target.signalCode === null) {
    try { target.kill("SIGKILL"); } catch {}
  }
}

function cleanup(reason: string): void {
  if (cleaning) return;
  cleaning = true;
  if (!target) {
    error ??= reason;
    finish();
    return;
  }
  if (reason === "OUTPUT_LIMIT") {
    killTargetForFinalization();
    return;
  }
  try { process.kill(-process.pid, "SIGTERM"); } catch {}
  setTimeout(() => {
    if (returnSent) killGroup();
    else killTargetForFinalization();
  }, 3_000);
}

process.on("SIGTERM", () => {
  if (!cleaning) cleanup("SIGTERM");
});
process.on("disconnect", () => cleanup("PARENT_LOST"));
process.on("message", (message: unknown) => {
  if (typeof message !== "object" || message === null || !("type" in message) || !("nonce" in message)
    || message.nonce !== nonce) return;
  if (message.type === "cancel") {
    cleanup("CANCELLED");
    return;
  }
  if (message.type !== "execute" || used || cleaning
    || !("attemptId" in message) || typeof message.attemptId !== "string"
    || !("executable" in message) || typeof message.executable !== "string"
    || !("args" in message) || !Array.isArray(message.args) || !message.args.every((value) => typeof value === "string")
    || !("cwd" in message) || typeof message.cwd !== "string"
    || !("evidenceDirectory" in message) || typeof message.evidenceDirectory !== "string"
    || !("timeoutMs" in message) || typeof message.timeoutMs !== "number") return;
  used = true;
  stdoutPath = join(message.evidenceDirectory, `${nonce}.stdout.raw`);
  stderrPath = join(message.evidenceDirectory, `${nonce}.stderr.raw`);
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW;
  stdoutDescriptor = openSync(stdoutPath, flags, 0o600);
  stderrDescriptor = openSync(stderrPath, flags, 0o600);
  target = spawn(message.executable, message.args, {
    cwd: message.cwd,
    detached: false,
    shell: false,
    stdio: ["ignore", stdoutDescriptor, stderrDescriptor],
  });
  target.once("error", (spawnError) => {
    error = spawnError.message;
    cleanup("SPAWN_ERROR");
  });
  target.once("exit", (code, receivedSignal) => {
    exitCode = code;
    signal = receivedSignal;
  });
  target.once("close", () => {
    if (outputPoll) clearInterval(outputPoll);
    if (stdoutDescriptor !== undefined) closeSync(stdoutDescriptor);
    if (stderrDescriptor !== undefined) closeSync(stderrDescriptor);
    finish();
  });
  outputPoll = setInterval(() => {
    if (stdoutDescriptor === undefined || stderrDescriptor === undefined) return;
    if (fstatSync(stdoutDescriptor).size + fstatSync(stderrDescriptor).size > MAX_RAW_BYTES) {
      truncated = true;
      error = "OUTPUT_LIMIT";
      cleanup("OUTPUT_LIMIT");
    }
  }, 25);
  outputPoll.unref();
  setTimeout(() => cleanup("TIMEOUT"), message.timeoutMs).unref();
});

process.send({ type: "ready", pid: process.pid, groupId: process.pid, nonce });
