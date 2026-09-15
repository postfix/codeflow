import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, test } from "vitest";
import { formatPrompt, readInstruction } from "../src/prompts.js";
import { prompt } from "../src/sdk.js";
import { assertWorkspaceFresh, captureWorkspace } from "../src/workspace.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "coding-flow-workspace-"));
  temporary.push(path);
  return path;
}

describe("workspace evidence", () => {
  test("canonical manifests cover the workspace while excluding state and declared disposable paths", async () => {
    const root = await workspace();
    await mkdir(join(root, "nested"));
    await mkdir(join(root, ".coding-flow"));
    await writeFile(join(root, "nested", "b.txt"), "b");
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "scratch.txt"), "ignored");
    await writeFile(join(root, ".coding-flow", "state"), "ignored");

    const manifest = await captureWorkspace(root, { disposablePaths: ["scratch.txt"] });
    expect(manifest.files.map((file) => file.path)).toEqual(["a.txt", "nested/b.txt"]);
    expect(manifest.totalBytes).toBe(2);
    await expect(assertWorkspaceFresh(manifest)).resolves.toBeUndefined();
  });

  test("stale content, added files, and removed files invalidate a baseline", async () => {
    const root = await workspace();
    const path = join(root, "value.txt");
    await writeFile(path, "before");
    const content = await captureWorkspace(root);
    await writeFile(path, "after");
    await expect(assertWorkspaceFresh(content)).rejects.toThrow("Workspace is stale");

    await writeFile(path, "before");
    const addition = await captureWorkspace(root);
    await writeFile(join(root, "added.txt"), "new");
    await expect(assertWorkspaceFresh(addition)).rejects.toThrow("Workspace is stale");

    const removal = await captureWorkspace(root);
    await rm(join(root, "added.txt"));
    await expect(assertWorkspaceFresh(removal)).rejects.toThrow("Workspace is stale");
  });

  test("symlinks and escaping disposable paths are rejected", async () => {
    const root = await workspace();
    await writeFile(join(root, "file.txt"), "value");
    await symlink("file.txt", join(root, "link.txt"));
    await expect(captureWorkspace(root)).rejects.toThrow("symbolic link");
    await expect(captureWorkspace(root, { disposablePaths: ["../outside"] })).rejects.toThrow("Invalid workspace path");
  });

  test("file, total-byte, and file-count bounds stop scans", async () => {
    const root = await workspace();
    await writeFile(join(root, "large.txt"), "12345");
    await expect(captureWorkspace(root, { maxFileBytes: 4 })).rejects.toThrow("file byte limit");
    await expect(captureWorkspace(root, { maxBytes: 4 })).rejects.toThrow("total byte limit");
    await writeFile(join(root, "second.txt"), "x");
    await expect(captureWorkspace(root, { maxFiles: 1 })).rejects.toThrow("file count limit");
  });

  test("a mutation between scans is rejected as unstable", async () => {
    const root = await workspace();
    await writeFile(join(root, "value.txt"), "before");
    await expect(captureWorkspace(root, {}, async () => {
      await writeFile(join(root, "value.txt"), "after");
    })).rejects.toThrow("Workspace changed during scan");
  });

  test("prompts and instruction files use bounded canonical values", async () => {
    const root = await workspace();
    await writeFile(join(root, "instructions.md"), "Do the thing.\n");
    const rendered = formatPrompt(["Value: ", ""] as unknown as TemplateStringsArray, { z: 1, a: 2 });
    expect(rendered).toBe('Value: {"a":2,"z":1}');
    expect(formatPrompt(["\n    Value:\n      ", "\n"] as unknown as TemplateStringsArray, "one\n  two"))
      .toBe("Value:\n  one\n  two");
    await expect(readInstruction(root, "instructions.md")).resolves.toBe("Do the thing.\n");
    expect(() => formatPrompt(["", ""] as unknown as TemplateStringsArray, "x".repeat(1024 * 1024 + 1)))
      .toThrow("Prompt exceeds 1 MiB limit");
    await expect(readInstruction(root, "../outside")).rejects.toThrow("escapes instruction root");
  });

  test("prompt interpolation cannot be mistaken for a later placeholder", () => {
    const rendered = formatPrompt(["A", "B", "C"] as unknown as TemplateStringsArray, "\0" + "1" + "\0", "X");
    expect(Buffer.from(rendered).toString("hex")).toBe("41003100425843");
  });

  test("prompt literals cannot overlap placeholder boundaries", () => {
    expect(Buffer.from(prompt`\x000${"X"}`).toString("hex")).toBe("003058");
  });

  test("prompt interpolation cannot synthesize a later placeholder across a literal boundary", () => {
    const rendered = formatPrompt(
      ["L0", "\0" + "1", "\0L2"] as unknown as TemplateStringsArray,
      "\0" + "1" + "\0",
      "v1",
    );
    expect(Buffer.from(rendered).toString("hex")).toBe("4c3000310000317631004c32");
  });

  test("large NUL-heavy prompts retain exact output without superlinear sentinel scans", () => {
    const value = "\0".repeat(200_000);
    const started = performance.now();
    const rendered = formatPrompt(["A", "B"] as unknown as TemplateStringsArray, value);
    const elapsed = performance.now() - started;
    expect(rendered).toBe(`A${value}B`);
    expect(elapsed).toBeLessThan(2_000);
  }, 15_000);
});
