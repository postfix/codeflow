import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syncDirectory } from "./artifacts.js";
import type { ArtifactRef } from "./contracts.js";

export interface BuiltFlow {
  readonly url: URL;
  readonly artifact: ArtifactRef;
}

export async function buildFlow(entry: URL, runDirectory: string): Promise<BuiltFlow> {
  const directory = join(runDirectory, "bundle");
  const outfile = join(directory, "flow.mjs");
  await mkdir(directory, { recursive: true });
  await build({
    entryPoints: [fileURLToPath(entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    sourcemap: false,
  });
  const file = await open(outfile, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(directory);
  const bytes = await readFile(outfile);
  return {
    url: pathToFileURL(outfile),
    artifact: {
      path: relative(runDirectory, outfile),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      mediaType: "text/javascript",
    },
  };
}
