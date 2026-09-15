import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { artifactRefSchema, canonicalJson, MAX_ARTIFACT_BYTES, MAX_JSON_BYTES, type ArtifactRef, type Json } from "./contracts.js";

interface Writer {
  write(bytes: Uint8Array, offset: number, length: number): Promise<{ readonly bytesWritten: number }>;
}

export interface DurableWriteHooks {
  readonly rename?: typeof rename;
  readonly syncDirectory?: typeof syncDirectory;
}

function isOutside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

export async function assertContainedPath(root: string, candidate: string): Promise<void> {
  const lexicalRoot = resolve(root);
  const lexicalCandidate = resolve(candidate);
  if (isOutside(lexicalRoot, lexicalCandidate)) throw new Error("Path escapes root");
  const actualRoot = await realpath(lexicalRoot);
  const actualCandidate = await realpath(lexicalCandidate);
  if (isOutside(actualRoot, actualCandidate)) throw new Error("Path escapes root");
}

export async function writeAll(writer: Writer, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await writer.write(bytes, offset, bytes.length - offset);
    if (bytesWritten <= 0) throw new Error("Short write made no progress");
    offset += bytesWritten;
  }
}

export async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error("Expected a regular file");
    if (before.size > maxBytes) throw new Error(`File exceeds ${String(maxBytes)} byte limit`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`File exceeds ${String(maxBytes)} byte limit`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("File changed while reading");
    }
    return Buffer.concat(chunks, total);
  } finally {
    await file.close();
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function writeDurable(path: string, bytes: Uint8Array, hooks: DurableWriteHooks = {}): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  let moved = false;
  try {
    try {
      await writeAll(file, bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await (hooks.rename ?? rename)(temporary, path);
    moved = true;
    await (hooks.syncDirectory ?? syncDirectory)(dirname(path));
  } catch (error) {
    if (!moved) await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function publishJson(runDirectory: string, path: string, value: Json): Promise<ArtifactRef> {
  const root = await realpath(runDirectory);
  const candidate = resolve(path);
  if (isOutside(root, candidate)) throw new Error("Artifact escapes run directory");
  const parent = await realpath(dirname(candidate));
  if (isOutside(root, parent) || parent !== dirname(candidate)) throw new Error("Artifact escapes run directory");
  await lstat(candidate).then(
    () => { throw new Error("Artifact already exists"); },
    (error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    },
  );
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (bytes.length > MAX_JSON_BYTES) throw new Error("Artifact exceeds 1 MiB JSON limit");
  await writeDurable(candidate, bytes);
  return {
    path: relative(root, candidate),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    mediaType: "application/json",
  };
}

export async function verifyArtifact(runDirectory: string, artifact: ArtifactRef): Promise<Buffer> {
  try {
    artifactRefSchema.parse(artifact);
    const root = await realpath(runDirectory);
    const candidate = resolve(root, artifact.path);
    if (isOutside(root, candidate)) throw new Error("Artifact escapes run directory");
    const actual = await realpath(candidate);
    if (isOutside(root, actual) || actual !== candidate) throw new Error("Artifact escapes run directory");
    const bytes = await readBoundedFile(actual, Math.min(artifact.bytes, MAX_ARTIFACT_BYTES));
    if (bytes.length !== artifact.bytes || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
      throw new Error("Artifact metadata mismatch");
    }
    return bytes;
  } catch {
    throw new Error("Corrupt journal");
  }
}
