import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { copyJson } from "../src/contracts.js";
import { startFlow } from "../src/host.js";
import { flow, prompt, z, type Json } from "../src/sdk.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "coding-flow-contract-"));
  temporary.push(path);
  return path;
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
    const entry = new URL("./fixtures/host-flow.ts", import.meta.url);
    for (const rawInput of [
      { message: new Date(0), delayMs: 0 },
      { message: "invalid", delayMs: Number.NaN },
      { message: "x".repeat(1024 * 1024), delayMs: 0 },
    ]) {
      const root = await workspace();
      await expect(startFlow(entry, rawInput, { workspace: root })).rejects.toThrow(/JSON|1 MiB/);
      await expect(access(join(root, "body-effects.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
