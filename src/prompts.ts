import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readBoundedFile } from "./artifacts.js";
import { canonicalJson, copyJson } from "./contracts.js";

export const MAX_PROMPT_BYTES = 1024 * 1024;

function dedent(value: string): string {
  const lines = value.split("\n");
  while (lines[0]?.trim() === "") lines.shift();
  while (lines.at(-1)?.trim() === "") lines.pop();
  const content = lines.filter((line) => line.trim() !== "");
  const indentation = content.length === 0
    ? 0
    : Math.min(...content.map((line) => line.match(/^[\t ]*/u)?.[0].length ?? 0));
  return lines.map((line) => line.trim() === "" ? "" : line.slice(indentation)).join("\n");
}

export function formatPrompt(strings: TemplateStringsArray, ...values: readonly unknown[]): string {
  const rendered = values.map((value) => typeof value === "string" ? value : canonicalJson(copyJson(value)));
  let maxNulRun = 0;
  for (const value of [...strings, ...rendered]) {
    let nulRun = 0;
    for (let index = 0; index < value.length; index += 1) {
      if (value.charCodeAt(index) === 0) maxNulRun = Math.max(maxNulRun, nulRun += 1);
      else nulRun = 0;
    }
  }
  const sentinel = "\0".repeat(maxNulRun + 1);
  const markers = rendered.map((_, index) => `${sentinel}${String(index)}${sentinel}`);
  const template = dedent(strings.map((string, index) => string + (markers[index] ?? "")).join(""));
  let result = "";
  let start = 0;
  for (const [index, value] of rendered.entries()) {
    const marker = markers[index] as string;
    const end = template.indexOf(marker, start);
    result += template.slice(start, end) + value;
    start = end + marker.length;
  }
  result += template.slice(start);
  if (Buffer.byteLength(result, "utf8") > MAX_PROMPT_BYTES) throw new Error("Prompt exceeds 1 MiB limit");
  return result;
}

export async function readInstruction(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(resolve(root));
  const candidate = resolve(canonicalRoot, path);
  const lexical = relative(canonicalRoot, candidate);
  if (lexical === "" || lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    throw new Error("Instruction path escapes instruction root");
  }
  let actual: string;
  try {
    actual = await realpath(candidate);
  } catch {
    throw new Error("Instruction file is unavailable");
  }
  if (actual !== candidate) throw new Error("Instruction path escapes instruction root");
  const bytes = await readBoundedFile(actual, MAX_PROMPT_BYTES);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Instruction file must be UTF-8");
  }
}
