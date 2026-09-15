import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readBoundedFile } from "./artifacts.js";
import { canonicalJson, type Json } from "./contracts.js";

const HARD_MAX_FILES = 10_000;
const HARD_MAX_BYTES = 512 * 1024 * 1024;
const HARD_MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface WorkspacePolicy {
  readonly disposablePaths?: readonly string[];
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly maxFileBytes?: number;
}

interface ResolvedPolicy {
  readonly disposablePaths: readonly string[];
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxFileBytes: number;
}

export interface WorkspaceFile {
  readonly path: string;
  readonly bytes: number;
  readonly mode: number;
  readonly sha256: string;
}

export interface WorkspaceManifest {
  readonly version: 1;
  readonly root: string;
  readonly files: readonly WorkspaceFile[];
  readonly directories: readonly { readonly path: string; readonly mode: number }[];
  readonly totalBytes: number;
  readonly sha256: string;
  readonly policy: ResolvedPolicy;
}

function limit(value: number | undefined, maximum: number, name: string): number {
  const actual = value ?? maximum;
  if (!Number.isSafeInteger(actual) || actual < 1 || actual > maximum) throw new Error(`Invalid ${name}`);
  return actual;
}

function relativePath(path: string): string {
  if (path === "" || isAbsolute(path) || path.includes("\\")) throw new Error("Invalid workspace path");
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error("Invalid workspace path");
  return parts.join("/");
}

function resolvePolicy(policy: WorkspacePolicy): ResolvedPolicy {
  const disposablePaths = [...new Set((policy.disposablePaths ?? []).map(relativePath))].sort();
  if (disposablePaths.some((path) => path === ".coding-flow" || path.startsWith(".coding-flow/"))) {
    throw new Error("Runtime state is already excluded from workspace evidence");
  }
  return {
    disposablePaths,
    maxFiles: limit(policy.maxFiles, HARD_MAX_FILES, "workspace file count limit"),
    maxBytes: limit(policy.maxBytes, HARD_MAX_BYTES, "workspace total byte limit"),
    maxFileBytes: limit(policy.maxFileBytes, HARD_MAX_FILE_BYTES, "workspace file byte limit"),
  };
}

function excluded(path: string, policy: ResolvedPolicy): boolean {
  return path === ".coding-flow" || path.startsWith(".coding-flow/")
    || policy.disposablePaths.some((item) => path === item || path.startsWith(`${item}/`));
}

async function scan(root: string, policy: ResolvedPolicy): Promise<Omit<WorkspaceManifest, "version" | "root" | "sha256" | "policy">> {
  const files: WorkspaceFile[] = [];
  const directories: { path: string; mode: number }[] = [];
  let totalBytes = 0;

  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = resolve(directory, name);
      const path = relative(root, absolute).split(sep).join("/");
      if (excluded(path, policy)) continue;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Workspace contains symbolic link: ${path}`);
      if (files.length + directories.length >= policy.maxFiles) throw new Error("Workspace exceeds file count limit");
      if (info.isDirectory()) {
        directories.push({ path, mode: info.mode & 0o777 });
        await visit(absolute);
        const after = await lstat(absolute);
        if (!after.isDirectory() || after.dev !== info.dev || after.ino !== info.ino || after.mtimeMs !== info.mtimeMs) {
          throw new Error("Workspace changed during scan");
        }
        continue;
      }
      if (!info.isFile()) throw new Error(`Workspace contains unsupported file: ${path}`);
      if (info.size > policy.maxFileBytes) throw new Error("Workspace exceeds file byte limit");
      totalBytes += info.size;
      if (totalBytes > policy.maxBytes) throw new Error("Workspace exceeds total byte limit");
      const bytes = await readBoundedFile(absolute, policy.maxFileBytes);
      const after = await lstat(absolute);
      if (!after.isFile() || after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size
        || after.mtimeMs !== info.mtimeMs || bytes.length !== info.size) throw new Error("Workspace changed during scan");
      files.push({
        path,
        bytes: bytes.length,
        mode: info.mode & 0o777,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }

  await visit(root);
  return { files, directories, totalBytes };
}

function scanHash(value: Omit<WorkspaceManifest, "version" | "root" | "sha256" | "policy">): string {
  return createHash("sha256").update(canonicalJson(value as unknown as Json)).digest("hex");
}

export async function captureWorkspace(
  workspace: string,
  requestedPolicy: WorkspacePolicy = {},
  betweenScans?: () => Promise<void>,
): Promise<WorkspaceManifest> {
  const requestedRoot = resolve(workspace);
  if ((await lstat(requestedRoot)).isSymbolicLink()) throw new Error("Workspace root must not be a symbolic link");
  const root = await realpath(requestedRoot);
  if (root !== requestedRoot) throw new Error("Workspace root must not traverse symbolic links");
  const policy = resolvePolicy(requestedPolicy);
  const first = await scan(root, policy);
  await betweenScans?.();
  const second = await scan(root, policy);
  const sha256 = scanHash(second);
  if (scanHash(first) !== sha256) throw new Error("Workspace changed during scan");
  return { version: 1, root, ...second, sha256, policy };
}

export async function assertWorkspaceFresh(expected: WorkspaceManifest): Promise<void> {
  const actual = await captureWorkspace(expected.root, expected.policy);
  if (actual.sha256 !== expected.sha256) throw new Error("Workspace is stale");
}
