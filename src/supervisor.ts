import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertContainedPath, publishJson, readBoundedFile, syncDirectory, verifyArtifact, writeDurable } from "./artifacts.js";
import { buildFlow } from "./build.js";
import { copyJson, MAX_JSON_BYTES, runManifestSchema, serializeError, startRequestSchema, type ArtifactRef, type JournalEvent, type Json } from "./contracts.js";
import { Journal, readVerifiedEvents } from "./journal.js";
import { acquireOwnership } from "./ownership.js";
import { ProcessService, type ProcessRequest, type RegisteredProcess, type RunnerReturn } from "./process.js";
import { initializeFlow, runFlow } from "./worker.js";

interface Initialization {
  readonly runId: string;
  readonly runDirectory: string;
  readonly workspace: string;
  readonly input: Json;
  readonly inputArtifact: ArtifactRef;
  readonly bundleArtifact: ArtifactRef;
  readonly bundle: URL;
  readonly journal: Journal;
}

export interface OwnedCommandContext extends ProcessRequest {
  readonly service: ProcessService;
  readonly runDirectory: string;
}

async function writeExclusiveDurable(path: string, bytes: Buffer): Promise<void> {
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(path));
}

async function claimAttempt(context: OwnedCommandContext): Promise<void> {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(context.attemptId)) throw new Error("Invalid process request");
  const directory = join(context.runDirectory, "operations");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await syncDirectory(context.runDirectory);
  try {
    await writeExclusiveDurable(join(directory, `${context.attemptId}.claim.json`), Buffer.from(JSON.stringify({
      attemptId: context.attemptId,
      executable: context.executable,
      args: context.args,
      cwd: context.cwd,
    })));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error("ATTEMPT_EXISTS");
    throw error;
  }
}

async function commitRegistration(context: OwnedCommandContext, registered: RegisteredProcess): Promise<void> {
  const directory = join(context.runDirectory, "operations");
  await writeExclusiveDurable(join(directory, `${context.attemptId}.registered.json`), Buffer.from(JSON.stringify({
    attemptId: registered.attemptId,
    groupId: registered.groupId,
    nonce: registered.nonce,
  })));
}

async function commitAuthorization(context: OwnedCommandContext, registered: RegisteredProcess): Promise<void> {
  await writeExclusiveDurable(join(context.runDirectory, "operations", `${context.attemptId}.authorized.json`), Buffer.from(JSON.stringify({
    attemptId: context.attemptId,
    executable: context.executable,
    args: context.args,
    cwd: context.cwd,
    groupId: registered.groupId,
    nonce: registered.nonce,
  })));
}

export async function authorizeAttempt(context: OwnedCommandContext): Promise<{
  readonly registered: RegisteredProcess;
  readonly returned: RunnerReturn;
}> {
  await claimAttempt(context);
  const registered = await context.service.register({ ...context, evidenceDirectory: context.runDirectory });
  try {
    await commitRegistration(context, registered);
    await commitAuthorization(context, registered);
    const returned = await context.service.authorizeTarget(registered, {
      attemptId: context.attemptId,
      nonce: registered.nonce,
    });
    return { registered, returned };
  } catch (error) {
    await context.service.terminate(registered, "authorization failed");
    throw error;
  }
}

async function commitOutcome(context: OwnedCommandContext, returned: RunnerReturn): Promise<void> {
  await writeExclusiveDurable(join(context.runDirectory, "operations", `${context.attemptId}.committed.json`), Buffer.from(JSON.stringify(returned)));
}

function deliverOutcome(returned: RunnerReturn): RunnerReturn {
  return returned;
}

export async function commitOutcomeAndDeliver(
  context: OwnedCommandContext,
  registered: RegisteredProcess,
  returned: RunnerReturn,
): Promise<RunnerReturn> {
  await context.service.assertGroupAbsent(registered.identity);
  await commitOutcome(context, returned);
  return deliverOutcome(returned);
}

export async function executeOwnedCommand(context: OwnedCommandContext): Promise<RunnerReturn> {
  const { registered, returned } = await authorizeAttempt(context);
  return commitOutcomeAndDeliver(context, registered, returned);
}

async function publishArtifact(runDirectory: string, path: string, value: Json): Promise<ArtifactRef> {
  return publishJson(runDirectory, path, value);
}

async function appendEventWithArtifacts(journal: Journal, type: JournalEvent["type"], data: Json): Promise<JournalEvent> {
  return journal.append(type, data);
}

async function publishEventWithArtifacts(
  journal: Journal,
  runDirectory: string,
  path: string,
  value: Json,
  type: JournalEvent["type"],
  data: (artifact: ArtifactRef) => Json,
): Promise<{ readonly artifact: ArtifactRef; readonly event: JournalEvent }> {
  const artifact = await publishArtifact(runDirectory, path, value);
  const event = await appendEventWithArtifacts(journal, type, data(artifact));
  return { artifact, event };
}

async function createRun(request: Extract<ReturnType<typeof startRequestSchema.parse>, { mode: "start" }>): Promise<Initialization> {
  const runId = randomUUID();
  const runsDirectory = join(request.workspace, ".coding-flow", "runs");
  const runDirectory = join(runsDirectory, runId);
  const artifactsDirectory = join(runDirectory, "artifacts");
  await mkdir(runsDirectory, { recursive: true, mode: 0o700 });
  await assertContainedPath(request.workspace, runsDirectory);
  await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
  const input = copyJson(request.rawInput);
  const inputArtifact = await publishArtifact(runDirectory, join(artifactsDirectory, "input.json"), input);
  const built = await buildFlow(new URL(request.entry), runDirectory);
  const manifest = {
    runId,
    entry: request.entry,
    workspace: request.workspace,
    inputArtifact,
    bundleArtifact: built.artifact,
    initializationCharges: { compilations: 1 as const, inputValidations: 0 as const },
  };
  await publishJson(runDirectory, join(runDirectory, "manifest.json"), manifest as unknown as Json);
  const journal = new Journal(runDirectory, runId);
  await appendEventWithArtifacts(journal, "run.created", { ...manifest, supervisorPid: process.pid } as unknown as Json);
  for (const directory of [runDirectory, runsDirectory, join(request.workspace, ".coding-flow"), request.workspace]) {
    await syncDirectory(directory);
  }
  process.send?.({ runId });
  process.disconnect?.();
  if (request.crashAfterRunCreated === true) process.exit(91);
  return { runId, runDirectory, workspace: request.workspace, input, inputArtifact, bundleArtifact: built.artifact, bundle: built.url, journal };
}

async function resumeRun(request: Extract<ReturnType<typeof startRequestSchema.parse>, { mode: "resume" }>): Promise<Initialization> {
  const runDirectory = join(request.workspace, ".coding-flow", "runs", request.runId);
  const history = await readVerifiedEvents(request.workspace, request.runId);
  if (history.length !== 1 || history[0]?.type !== "run.created") throw new Error("Run is not awaiting initialization");
  const manifest = runManifestSchema.parse(JSON.parse((await readBoundedFile(join(runDirectory, "manifest.json"), MAX_JSON_BYTES)).toString("utf8")));
  const created = runManifestSchema.passthrough().safeParse(history[0].data);
  if (!created.success || JSON.stringify(manifest) !== JSON.stringify({
    runId: created.data.runId,
    entry: created.data.entry,
    workspace: created.data.workspace,
    inputArtifact: created.data.inputArtifact,
    bundleArtifact: created.data.bundleArtifact,
    initializationCharges: created.data.initializationCharges,
  })) throw new Error("Corrupt journal");
  if (created.data.runId !== request.runId || created.data.workspace !== request.workspace) throw new Error("Run identity mismatch");
  const inputBytes = await verifyArtifact(runDirectory, created.data.inputArtifact);
  await verifyArtifact(runDirectory, created.data.bundleArtifact);
  const input = copyJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inputBytes)));
  process.send?.({ runId: request.runId });
  process.disconnect?.();
  return {
    runId: request.runId,
    runDirectory,
    workspace: request.workspace,
    input,
    inputArtifact: created.data.inputArtifact,
    bundleArtifact: created.data.bundleArtifact,
    bundle: pathToFileURL(resolve(runDirectory, created.data.bundleArtifact.path)),
    journal: new Journal(runDirectory, request.runId, history),
  };
}

export async function supervise(rawRequest: unknown): Promise<void> {
  const request = startRequestSchema.parse(rawRequest);
  const ownership = await acquireOwnership(request.workspace);
  try {
    const initialization = request.mode === "start" ? await createRun(request) : await resumeRun(request);
    const { bundle, bundleArtifact, input, inputArtifact, journal, runDirectory, workspace } = initialization;
    const artifactsDirectory = join(runDirectory, "artifacts");
    let terminal: JournalEvent;
    try {
      const initialized = await initializeFlow(bundle, input);
      await journal.append("run.initialized", {
        bundleArtifact,
        inputArtifact,
        initializationCharges: { compilations: 1, inputValidations: 1 },
        supervisorPid: process.pid,
      } as unknown as Json);
      const service = new ProcessService();
      const definition = initialized.definition;
      let acceptingCommands = true;
      let commandUsed = false;
      const issuedCommands = new Set<Promise<RunnerReturn>>();
      let output: Json;
      try {
        output = await runFlow({
          ...initialized,
          definition: {
            ...definition,
            run: (context) => definition.run({
              ...context,
              command: (executable, args = []) => {
                if (!acceptingCommands) {
                  const rejected = Promise.reject(new Error("COMMAND_CLOSED"));
                  void rejected.catch(() => undefined);
                  return rejected;
                }
                if (commandUsed || definition.limits?.maxCommands === 0) throw new Error("COMMAND_LIMIT");
                commandUsed = true;
                const issued = executeOwnedCommand({
                  service,
                  runDirectory,
                  attemptId: "command-1",
                  executable,
                  args,
                  cwd: workspace,
                  timeoutMs: definition.limits?.timeoutMs ?? 30 * 60_000,
                  evidenceDirectory: runDirectory,
                });
                issuedCommands.add(issued);
                void issued.then(
                  () => issuedCommands.delete(issued),
                  () => issuedCommands.delete(issued),
                );
                return issued;
              },
            }),
          },
        }, workspace);
      } finally {
        acceptingCommands = false;
        await service.dispose();
        await Promise.allSettled([...issuedCommands]);
      }
      ({ event: terminal } = await publishEventWithArtifacts(
        journal,
        runDirectory,
        join(artifactsDirectory, "output.json"),
        output,
        "run.succeeded",
        (outputArtifact) => ({ outputArtifact } as unknown as Json),
      ));
    } catch (error) {
      ({ event: terminal } = await publishEventWithArtifacts(
        journal,
        runDirectory,
        join(artifactsDirectory, "error.json"),
        serializeError(error) as unknown as Json,
        "run.failed",
        (errorArtifact) => ({ errorArtifact } as unknown as Json),
      ));
    }
    await writeDurable(join(runDirectory, "result.json"), Buffer.from(`${JSON.stringify(terminal)}\n`));
  } finally {
    ownership.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const request = await new Promise<unknown>((resolveRequest) => process.once("message", resolveRequest));
  await supervise(request);
}
