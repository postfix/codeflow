import { build } from "esbuild";
import { builtinModules, createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertContainedPath, syncDirectory } from "./artifacts.js";
import type { ArtifactRef } from "./contracts.js";

export interface BuiltFlow {
  readonly url: URL;
  readonly artifact: ArtifactRef;
}

export async function buildFlow(entry: URL, runDirectory: string, workspace = dirname(fileURLToPath(entry))): Promise<BuiltFlow> {
  const entryPath = fileURLToPath(entry);
  try {
    await assertContainedPath(workspace, entryPath);
  } catch (error) {
    throw new Error("Flow entry is outside workspace", { cause: error });
  }
  const directory = join(runDirectory, "bundle");
  const outfile = join(directory, "flow.mjs");
  await mkdir(directory, { recursive: true });
  const runtimeRoot = dirname(fileURLToPath(import.meta.url));
  const trustedRoots = [runtimeRoot, resolve(runtimeRoot, "../../src")];
  const packageRoot = dirname(createRequire(import.meta.url).resolve("zod"));
  const containedBy = (roots: readonly string[], path: string): boolean => roots.some((root) => {
    const location = relative(root, path);
    return location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location);
  });
  const trustedSource = (path: string): boolean => containedBy(trustedRoots, path);
  const publicSource = (path: string): boolean => trustedRoots.some((root) =>
    path === resolve(root, "sdk.js") || path === resolve(root, "sdk.ts"));
  const trustedImporter = (importer: string): boolean => trustedSource(importer) || containedBy([packageRoot], importer);
  const inWorkspace = (path: string): boolean => {
    const location = relative(resolve(workspace), path);
    return location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location);
  };
  const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
  const resolving = {};
  await build({
    entryPoints: [entryPath],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    supported: { "dynamic-import": false },
    banner: { js: "const require = undefined;" },
    sourcemap: false,
    plugins: [{
      name: "coding-flow-imports",
      setup(flowBuild) {
        flowBuild.onResolve({ filter: /.*/ }, async (args) => {
          if (args.pluginData === resolving || !args.importer || trustedImporter(args.importer)) return undefined;
          if (builtins.has(args.path)) return { errors: [{ text: `Flow source cannot import ${args.path}` }] };
          if (!args.path.startsWith(".") && !isAbsolute(args.path) && args.path !== "coding-flow") {
            return { errors: [{ text: `Flow source cannot import package ${args.path}` }] };
          }
          const resolved = await flowBuild.resolve(args.path, {
            importer: args.importer, namespace: args.namespace, resolveDir: args.resolveDir,
            kind: args.kind, pluginData: resolving, with: args.with,
          });
          if (resolved.errors.length > 0) return { errors: resolved.errors };
          const candidate = await realpath(resolved.path);
          if ((trustedSource(candidate) && !publicSource(candidate)) || (!inWorkspace(candidate) && !publicSource(candidate))) {
            return { errors: [{ text: "Flow source may import only the public coding-flow interface" }] };
          }
          return {
            path: candidate, external: resolved.external, namespace: resolved.namespace,
            sideEffects: resolved.sideEffects, suffix: resolved.suffix, warnings: resolved.warnings,
          };
        });
      },
    }],
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
