import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildFlow } from "../src/build.js";
import { copyJson, portableHumanContract } from "../src/contracts.js";
import { startFlow } from "../src/host.js";
import { flow, prompt, z, type Json } from "../src/sdk.js";

const temporary: string[] = [];
const runtime = { provider: "codex" as const };

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "coding-flow-contract-"));
  temporary.push(path);
  return path;
}

async function hostFlow(root: string): Promise<URL> {
  const target = join(root, "host-flow.ts");
  const source = await readFile(new URL("./fixtures/host-flow.ts", import.meta.url), "utf8");
  const sdk = fileURLToPath(new URL("../dist/src/sdk.js", import.meta.url));
  await writeFile(target, source.replace("../../src/sdk.js", sdk));
  return pathToFileURL(target);
}

function declares(schema: z.ZodType<unknown>): () => unknown {
  return () => flow({
    name: "contract-check",
    description: "Checks one public contract.",
    input: schema as z.ZodType<Json, Json>,
    output: z.string(),
    async run() { return "ok"; },
  });
}

describe("public contracts", () => {
  test("rejects unsupported emitted human-schema keywords before publication", () => {
    expect(() => portableHumanContract(z.base64())).toThrow("Unsupported human contract keyword");
  });

  test("public prompts dedent literals and canonically preserve interpolations", () => {
    const multiline = "first\n      second";

    expect(prompt`
      Before
        ${multiline}
      ${{ z: 1, a: 2 }}
    `).toBe('Before\n  first\n      second\n{"a":2,"z":1}');
    expect(() => prompt`${undefined}`).toThrow("Input must be JSON");
  });

  test("public prompts accept exactly 1 MiB and reject one byte more", () => {
    expect(Buffer.byteLength(prompt`${"x".repeat(1024 * 1024)}`)).toBe(1024 * 1024);
    expect(() => prompt`${"x".repeat(1024 * 1024 + 1)}`).toThrow("Prompt exceeds 1 MiB limit");
  });

  test("JSON copies preserve own __proto__ keys as inert data", () => {
    const copied = copyJson(JSON.parse('{"__proto__":{"polluted":true}}')) as Record<string, Json>;

    expect(Object.getPrototypeOf(copied)).toBeNull();
    expect(Object.hasOwn(copied, "__proto__")).toBe(true);
    expect(copied.__proto__).toEqual({ polluted: true });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  test("initialization and contract rejects impure or unsupported schemas", () => {
    for (const schema of [
      z.coerce.string(),
      z.string().default("default"),
      z.string().transform((value) => value.trim()),
      z.string().refine(async () => true),
      z.date(),
    ]) {
      expect(declares(schema)).toThrow("Unsupported contract");
    }
  });

  test("initialization and contract rejects Promise-returning refinements at declaration", () => {
    expect(() => flow({
      name: "promise-refinement",
      description: "Rejects validation that cannot be proven synchronous.",
      input: z.string(),
      output: z.string().refine(() => Promise.resolve(true)),
      async run() { return "ok"; },
    })).toThrow("Unsupported contract: asynchronous validation is forbidden");
  });

  test("initialization and contract rejects super refinements before author work", () => {
    let effects = 0;
    for (const input of [
      z.string().superRefine(() => { effects += 1; }),
      z.string().superRefine(async () => { effects += 1; }),
    ]) {
      expect(() => flow({
        name: "super-refinement",
        description: "Rejects custom validation that cannot be proven synchronous.",
        input,
        output: z.string(),
        async run() { effects += 1; return "ok"; },
      })).toThrow("Unsupported contract: asynchronous validation is forbidden");
    }
    expect(effects).toBe(0);
  });

  test("initialization and contract rejects non-JSON and oversized input before author work", async () => {
    for (const rawInput of [
      { message: new Date(0), delayMs: 0 },
      { message: "invalid", delayMs: Number.NaN },
      { message: "x".repeat(1024 * 1024), delayMs: 0 },
    ]) {
      const root = await workspace();
      const entry = await hostFlow(root);
      await expect(startFlow(entry, rawInput, { workspace: root, runtime })).rejects.toThrow(/JSON|1 MiB/);
      await expect(access(join(root, "body-effects.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

describe("author primitive composition finalization contracts", () => {
  test("flow validates and freezes limits and disposable paths", () => {
    const definition = flow({
      name: "frozen-flow", description: "Frozen public metadata.", input: z.null(), output: z.null(),
      limits: { maxCommands: 1 }, disposablePaths: ["scratch"], async run() { return null; },
    });
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.limits)).toBe(true);
    expect(Object.isFrozen(definition.disposablePaths)).toBe(true);
    expect(() => flow({
      name: "bad-limit", description: "Bad limit.", input: z.null(), output: z.null(),
      limits: { maxCommands: -1 }, async run() { return null; },
    })).toThrow("Invalid maxCommands");
    expect(() => flow({
      name: "bad-path", description: "Bad path.", input: z.null(), output: z.null(),
      disposablePaths: [".coding-flow/state"], async run() { return null; },
    })).toThrow("Invalid disposable path");
  });

  test("build rejects direct Node effects in author source", async () => {
    const root = await workspace();
    const entry = join(root, "direct-effect.mjs");
    await writeFile(entry, `import { writeFile } from "node:fs/promises";
      export default { kind: "coding-flow/v2", name: "direct-effect", description: "forbidden",
        input: { parse: value => value }, output: { parse: value => value },
        run: async () => { await writeFile("effect", "bad"); return null; } };\n`);
    await expect(startFlow(pathToFileURL(entry), null, { workspace: root, runtime })).rejects.toThrow("cannot import node:fs/promises");
    await expect(access(join(root, "effect"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("computed dynamic imports cannot escape the author import boundary", async () => {
    const root = await workspace();
    const outside = await workspace();
    const effect = join(outside, "computed-import-effect.txt");
    const sdk = fileURLToPath(new URL("../dist/src/sdk.js", import.meta.url));
    const entry = join(root, "computed-import.mjs");
    await writeFile(entry, `
      import { flow, z } from ${JSON.stringify(sdk)};
      const specifier = "node:fs/promises";
      export default flow({
        name: "computed-import", description: "must be rejected", input: z.null(), output: z.null(),
        run: async () => {
          const { writeFile } = await import(specifier);
          await writeFile(${JSON.stringify(effect)}, "escaped");
          return null;
        },
      });
    `);

    const started = await startFlow(pathToFileURL(entry), null, { workspace: root, runtime });
    const result = await started.wait(10_000);
    await expect(access(effect)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result).toMatchObject({ status: "failed" });
  }, 15_000);

  test("literal dynamic imports retain contained workspace modules", async () => {
    const root = await workspace();
    const sdk = fileURLToPath(new URL("../dist/src/sdk.js", import.meta.url));
    await writeFile(join(root, "literal-child.mjs"), `export const value = "contained";\n`);
    const entry = join(root, "literal-import.mjs");
    await writeFile(entry, `
      import { flow, z } from ${JSON.stringify(sdk)};
      export default flow({
        name: "literal-import", description: "contained import", input: z.null(), output: z.string(),
        run: async () => (await import("./literal-child.mjs")).value,
      });
    `);

    const started = await startFlow(pathToFileURL(entry), null, { workspace: root, runtime });
    await expect(started.wait(10_000)).resolves.toMatchObject({ status: "succeeded", output: "contained" });
  }, 15_000);

  test("buildFlow and startFlow reject an entry outside the declared workspace before author execution", async () => {
    const root = await workspace();
    const outside = await workspace();
    const entry = join(outside, "outside-entry.mjs");
    await writeFile(entry, `export default {
      kind: "coding-flow/v2", name: "outside-entry", description: "must be rejected",
      input: { parse: value => value }, output: { parse: value => value },
      run: async () => "must-not-run"
    };\n`);

    await expect(buildFlow(pathToFileURL(entry), join(root, "direct-build"), root))
      .rejects.toThrow("outside workspace");
    const error = await startFlow(pathToFileURL(entry), null, { workspace: root, runtime }).then(
      async (started) => { await started.wait(10_000); return undefined; },
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("outside workspace");

    const linkedEntry = join(root, "linked-entry.mjs");
    await symlink(entry, linkedEntry);
    await expect(buildFlow(pathToFileURL(linkedEntry), join(root, "linked-build"), root))
      .rejects.toThrow("outside workspace");
  }, 15_000);

  test("build rejects a child import whose workspace symlink resolves outside the workspace", async () => {
    const root = await workspace();
    const outside = await workspace();
    const child = join(outside, "outside-child.mjs");
    await writeFile(child, `export const value = "must-not-load";\n`);
    await symlink(child, join(root, "linked-child.mjs"));
    const entry = join(root, "linked-import.mjs");
    await writeFile(entry, `
      import { value } from "./linked-child.mjs";
      export default { kind: "coding-flow/v2", name: "linked-import", description: "must be rejected",
        input: { parse: value => value }, output: { parse: value => value }, run: async () => value };
    `);

    await expect(startFlow(pathToFileURL(entry), null, { workspace: root, runtime }))
      .rejects.toThrow("public coding-flow interface");
  }, 15_000);

  test("build trusts only pinned engine dependencies, not workspace node_modules", async () => {
    const root = await workspace();
    const dependency = join(root, "node_modules", "workspace-effect");
    const effect = join(root, "untrusted-effect.txt");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(dependency, { recursive: true }));
    await writeFile(join(dependency, "index.mjs"), `
      import { writeFile } from "node:fs/promises";
      export const runEffect = async () => writeFile(${JSON.stringify(effect)}, "bad");
    `);
    const entry = join(root, "workspace-dependency.mjs");
    await writeFile(entry, `
      import { runEffect } from "./node_modules/workspace-effect/index.mjs";
      export default { kind: "coding-flow/v2", name: "workspace-dependency", description: "must be rejected",
        input: { parse: value => value }, output: { parse: value => value },
        run: async () => { await runEffect(); return null; } };
    `);

    const error = await startFlow(pathToFileURL(entry), null, { workspace: root, runtime }).then(
      async (started) => { await started.wait(10_000); return undefined; },
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("cannot import node:fs/promises");
    await expect(access(effect)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  test("build blocks author-direct engine internals while retaining only the public interface", async () => {
    const root = await workspace();
    const outside = await workspace();
    const effect = join(outside, "internal-effect.txt");
    const internal = fileURLToPath(new URL("../dist/src/artifacts.js", import.meta.url));
    const entry = join(root, "direct-internal.mjs");
    await writeFile(entry, `
      import { writeDurable } from ${JSON.stringify(internal)};
      export default { kind: "coding-flow/v2", name: "direct-internal", description: "must be rejected",
        input: { parse: value => value }, output: { parse: value => value },
        run: async () => { await writeDurable(${JSON.stringify(effect)}, Buffer.from("bad")); return null; } };
    `);

    const error = await startFlow(pathToFileURL(entry), null, { workspace: root, runtime }).then(
      async (started) => { await started.wait(10_000); return undefined; },
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("public coding-flow interface");
    await expect(access(effect)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);
});
