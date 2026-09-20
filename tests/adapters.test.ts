import { mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { claudeAdapter, decodeClaudeAuth, decodeClaudeResult } from "../src/adapters/claude.js";
import { captureCodexEvidence, codexAdapter, decodeCodexAuth, decodeCodexResult } from "../src/adapters/codex.js";
import type { NativeProviderEvidence, ProviderRequest } from "../src/adapters/types.js";
import { ProcessService, type RunnerReturn } from "../src/process.js";
import { dispatchProvider, executeOwnedCommand } from "../src/supervisor.js";
import type { Adapter } from "../src/adapters/types.js";

const temporary: string[] = [];

async function directory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "codeflow-adapter-")));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

function request(operationDirectory: string, provider: "codex" | "claude", structured = true): ProviderRequest {
  return {
    prompt: "sanitized task",
    ...(structured ? { schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } : {}),
    access: "write",
    model: provider === "codex" ? "gpt-5.6-codex" : "claude-sonnet-4-5",
    workspace: "/workspace with spaces;$(no-shell)",
    operationDirectory,
    timeoutMs: 5_000,
  };
}

function returned(stdoutPath: string): RunnerReturn {
  return { exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, stdoutPath };
}

async function nativeEvidence(stdoutPath: string, provider: "codex" | "claude"): Promise<NativeProviderEvidence> {
  return { version: 1, captureContext: { startedAt: "2026-09-18T14:00:00.000Z", returnedAt: "2026-09-18T14:00:02.000Z" },
    status: { exitCode: 0, signal: null, errorPresent: false }, stdout: await readFile(stdoutPath),
    ...(provider === "codex" ? { finalOutput: await readFile(join(stdoutPath, "..", "final.txt")),
      codexSession: JSON.parse(await readFile(new URL("fixtures/codex-session.json", import.meta.url), "utf8")) } : {}) };
}

function statusService(...results: RunnerReturn[]): ProcessService {
  return {
    async register() { return { nonce: "status-nonce" }; },
    async authorizeTarget() {
      const result = results.shift();
      if (!result) throw new Error("Unexpected status probe");
      return result;
    },
    async terminate() {},
  } as unknown as ProcessService;
}

describe("native provider adapters", () => {
  test("native evidence Codex joins only the bounded current session and rejects metadata substitution", async () => {
    const root = await directory();
    const nativeHome = join(root, "native-home");
    const day = join(nativeHome, "sessions", "2026", "09", "18");
    const operationDirectory = join(root, "operation");
    await mkdir(day, { recursive: true });
    await mkdir(operationDirectory);
    const providerRequest = { ...request(operationDirectory, "codex"), workspace: root };
    const id = "00000000-0000-4000-8000-000000000011";
    const file = join(day, `rollout-synthetic-${id}.jsonl`);
    const stdoutPath = join(operationDirectory, "stdout.raw");
    await writeFile(stdoutPath, await readFile(new URL("fixtures/codex.jsonl", import.meta.url)));
    await writeFile(join(operationDirectory, "final.txt"), '{"ok":true}');
    const context = { startedAt: "2026-09-18T14:00:00.000Z", returnedAt: "2026-09-18T14:00:02.000Z" };
    const header = { id, source: "exec", cli_version: "0.154.0", cwd: root, timestamp: "2026-09-18T14:00:01.000Z" };
    const session = (changes: Record<string, unknown> = {}, prompt = providerRequest.prompt, model = providerRequest.model) => [
      { type: "session_meta", payload: { ...header, ...changes } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } },
      { type: "turn_context", payload: { model } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(file, session());
    const captured = await captureCodexEvidence(providerRequest, returned(stdoutPath), context, { CODEX_HOME: nativeHome });
    await expect(decodeCodexResult(providerRequest, captured)).resolves.toMatchObject({ actualModel: providerRequest.model, structured: { ok: true } });
    const original = session().trim().split("\n");
    const contextRecord = { type: "response_item", payload: { type: "message", role: "user", content: [
      { type: "input_text", text: "synthetic context one" }, { type: "input_text", text: "synthetic context two" },
      { type: "input_text", text: "synthetic context three" },
    ] } };
    const observedShape = [original[0], JSON.stringify(contextRecord), ...original.slice(1)].join("\n") + "\n";
    await writeFile(file, observedShape);
    await expect(captureCodexEvidence(providerRequest, returned(stdoutPath), context, { CODEX_HOME: nativeHome })).resolves.toBeDefined();
    const unrelated = { type: "response_item", payload: { type: "message", role: "user",
      content: [{ type: "input_text", text: "unrelated extra user input" }] } };
    await writeFile(file, observedShape + JSON.stringify(unrelated) + "\n");
    await expect(captureCodexEvidence(providerRequest, returned(stdoutPath), context, { CODEX_HOME: nativeHome }))
      .rejects.toThrow("Codex session join failed");
    await writeFile(file, session());
    await expect(decodeCodexResult(providerRequest, { ...captured, codexSession: {
      ...captured.codexSession!, promptSha256: "0".repeat(64),
    } })).rejects.toThrow("MODEL_MISMATCH");
    await expect(decodeCodexResult(providerRequest, { ...captured, codexSession: {
      ...captured.codexSession!, startedAt: "invalid-timestamp",
    } })).rejects.toThrow("MODEL_MISMATCH");
    for (const [changes, prompt, model] of [
      [{ id: "00000000-0000-4000-8000-000000000012" }, providerRequest.prompt, providerRequest.model],
      [{ source: "interactive" }, providerRequest.prompt, providerRequest.model],
      [{ cli_version: "0.153.0" }, providerRequest.prompt, providerRequest.model],
      [{ cwd: "/different" }, providerRequest.prompt, providerRequest.model],
      [{ timestamp: "2026-09-18T13:59:59.000Z" }, providerRequest.prompt, providerRequest.model],
      [{}, "different prompt", providerRequest.model],
      [{}, providerRequest.prompt, "different-model"],
    ] as const) {
      await writeFile(file, session(changes, prompt, model));
      await expect(captureCodexEvidence(providerRequest, returned(stdoutPath), context, { CODEX_HOME: nativeHome })).rejects.toThrow();
    }
    await writeFile(file, session());
    await writeFile(join(day, `second-${id}.jsonl`), session());
    await expect(captureCodexEvidence(providerRequest, returned(stdoutPath), context, { CODEX_HOME: nativeHome })).rejects.toThrow("ambiguous");
    await rm(join(day, `second-${id}.jsonl`));
    const uid = process.getuid!();
    const owner = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      await expect(captureCodexEvidence(providerRequest, returned(stdoutPath), context, { CODEX_HOME: nativeHome })).rejects.toThrow("unsafe");
    } finally { owner.mockRestore(); }
    await rm(file);
    await expect(decodeCodexResult(providerRequest, captured)).resolves.toMatchObject({ actualModel: providerRequest.model });
    await symlink(join(operationDirectory, "final.txt"), file);
    await expect(captureCodexEvidence(providerRequest, returned(stdoutPath), context, { CODEX_HOME: nativeHome })).rejects.toThrow();
    await rm(file);
    await writeFile(file, "");
    await truncate(file, 32 * 1024 * 1024 + 1);
    await expect(captureCodexEvidence(providerRequest, returned(stdoutPath), context, { CODEX_HOME: nativeHome })).rejects.toThrow("unsafe");
    await rm(file);
    for (let index = 0; index < 4097; index += 1) await writeFile(join(day, `unrelated-${index}`), "");
    await expect(captureCodexEvidence(providerRequest, returned(stdoutPath), context, { CODEX_HOME: nativeHome })).rejects.toThrow("4096 entries");
    await rm(day, { recursive: true });
    const outsideDay = join(root, "outside-day");
    await mkdir(outsideDay);
    await symlink(outsideDay, day);
    await expect(captureCodexEvidence(providerRequest, returned(stdoutPath), context, { CODEX_HOME: nativeHome })).rejects.toThrow("unsafe");
    await expect(captureCodexEvidence(providerRequest, returned(stdoutPath),
      { startedAt: "2026-09-17T00:00:00.000Z", returnedAt: "2026-09-19T00:00:00.000Z" }, { CODEX_HOME: nativeHome }))
      .rejects.toThrow("INTERVAL_INVALID");
  });

  test("native evidence Claude accepts root messages and rejects auxiliary-only or conflicting attestations", async () => {
    const root = await directory();
    const providerRequest = request(root, "claude");
    const rows = (await readFile(new URL("fixtures/claude.jsonl", import.meta.url), "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const evidence = (events: readonly Record<string, unknown>[]): NativeProviderEvidence => ({
      version: 1, captureContext: { startedAt: "2026-09-18T14:00:00.000Z", returnedAt: "2026-09-18T14:00:02.000Z" },
      status: { exitCode: 0, signal: null, errorPresent: false }, stdout: Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n"),
    });
    const auxiliary = { type: "assistant", session_id: "another-session", parent_tool_use_id: "tool-1",
      message: { model: "claude-haiku-4-5-20251001", content: [] } };
    await expect(decodeClaudeResult(providerRequest, evidence([rows[0]!, auxiliary, rows[1]!, rows[2]!]))).resolves.toMatchObject({
      actualModel: providerRequest.model, structured: { ok: true },
    });
    await expect(decodeClaudeResult(providerRequest, evidence([rows[0]!, auxiliary, rows[2]!]))).rejects.toThrow("MODEL_MISMATCH");
    await expect(decodeClaudeResult(providerRequest, evidence([rows[0]!, { ...rows[1]!, parent_tool_use_id: 0 }, rows[2]!]))).rejects.toThrow("parent");
    await expect(decodeClaudeResult(providerRequest, evidence([rows[0]!, { ...rows[1]!, message: { model: "wrong" } }, rows[2]!]))).rejects.toThrow("MODEL_MISMATCH");
    await expect(decodeClaudeResult(providerRequest, evidence([rows[0]!, { ...rows[1]!, session_id: "wrong" }, rows[2]!]))).rejects.toThrow("session");
    await expect(decodeClaudeResult(providerRequest, evidence([...rows, rows[2]!]))).rejects.toThrow("ambiguous");
    await expect(decodeClaudeResult(providerRequest, evidence([rows[2]!]))).rejects.toThrow("ambiguous");
    await expect(decodeClaudeResult(providerRequest, evidence([{ type: "system", subtype: "init", model: providerRequest.model,
      session_id: "session-sanitized", extra: "x".repeat(2 * 1024 * 1024) }, rows[1]!, rows[2]!]))).rejects.toThrow("2 MiB");
  });
  test("native evidence uses Claude's pinned verbose stream format", async () => {
    const root = await directory();
    const adapter = claudeAdapter(new ProcessService(), { operationDirectory: root, environment: {} });
    const args = adapter.invocation(request(root, "claude")).args;
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
  });
  test("rejects escaped and nondirectory output evidence before process registration", async () => {
    const root = await directory();
    const outside = await directory();
    await symlink(outside, join(root, "escaped"));
    await writeFile(join(root, "file"), "not a directory");
    let registrations = 0;
    const service = { async register() { registrations += 1; throw new Error("must not register"); } } as unknown as ProcessService;
    for (const evidenceDirectory of [outside, join(root, "escaped"), join(root, "file")]) {
      await expect(executeOwnedCommand({ service, runDirectory: root, evidenceDirectory, attemptId: "refused", executable: process.execPath,
        args: [], cwd: root, timeoutMs: 1_000 })).rejects.toThrow();
    }
    expect(registrations).toBe(0);
  });
  test("structural native authentication rejects contradictory and prose lookalikes", () => {
    expect(decodeClaudeAuth('{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","subscriptionType":"max"}')).not.toBe("subscription");
    expect(decodeClaudeAuth('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"bedrock","subscriptionType":"max"}')).not.toBe("subscription");
    expect(decodeCodexAuth('Error: forced_login_method="chatgpt"')).toBe("unknown");
    expect(decodeCodexAuth("error: not logged in")).toBe("unknown");
    expect(decodeClaudeAuth("not logged in")).toBe("unknown");
  });

  test("completes qualified preflight and invocation construction before durable dispatch authority", async () => {
    const root = await directory();
    const order: string[] = [];
    const adapter: Adapter = {
      async status() {
        order.push("preflight");
        return { provider: "codex", executable: "unused", version: "0.154.0", auth: "subscription", qualified: true };
      },
      invocation(providerRequest) {
        order.push("invocation");
        return { executable: "unused", args: [], cwd: providerRequest.workspace, stdin: providerRequest.prompt };
      },
      async capture() { throw new Error("not dispatched"); },
      async decode() { throw new Error("not dispatched"); },
    };
    const service = new ProcessService();
    try {
      await expect(dispatchProvider({
        adapter, service, runDirectory: root, attemptId: "agent-1", request: request(root, "codex"),
        signal: new AbortController().signal,
        async perform(_dispatch, prepare, afterPrepared) {
          void _dispatch; await prepare(); order.push("prepared");
          await afterPrepared({ ordinal: 1, preparedHash: "0".repeat(64), kind: "agent" });
          order.push("authorized"); return "not-dispatched";
        },
        async prepare() { order.push("setup"); },
      })).resolves.toBe("not-dispatched");
      expect(order).toEqual(["setup", "prepared", "preflight", "invocation", "authorized"]);
    } finally { await service.dispose(); }
  });

  test("returns a committed provider result without qualification, preparation, or redispatch", async () => {
    const root = await directory();
    let preflights = 0;
    let invocations = 0;
    let preparations = 0;
    let redispatches = 0;
    const adapter: Adapter = {
      async status() { preflights += 1; throw new Error("RUNTIME_UNQUALIFIED"); },
      invocation(providerRequest) {
        invocations += 1;
        return { executable: "unused", args: [], cwd: providerRequest.workspace, stdin: providerRequest.prompt };
      },
      async capture() { redispatches += 1; throw new Error("must not capture"); },
      async decode() { redispatches += 1; throw new Error("must not decode"); },
    };
    const service = new ProcessService();
    try {
      await expect(dispatchProvider({
        adapter, service, runDirectory: root, attemptId: "agent-1", request: request(root, "codex"),
        signal: new AbortController().signal,
        async perform(_dispatch, _prepare) {
          void _dispatch;
          void _prepare;
          return { verdict: "durable" };
        },
        async prepare() { preparations += 1; },
      })).resolves.toEqual({ verdict: "durable" });
      expect({ preflights, invocations, preparations, redispatches }).toEqual({
        preflights: 0, invocations: 0, preparations: 0, redispatches: 0,
      });
    } finally { await service.dispose(); }
  });

  test("builds exact Codex and Claude argument arrays without shell interpolation", async () => {
    const root = await directory();
    const service = new ProcessService();
    try {
      const codex = codexAdapter(service, { operationDirectory: root, environment: {} }).invocation(request(root, "codex"));
      expect(codex).toEqual({
        executable: "codex",
        args: [
          "--ask-for-approval", "never", "-c", "forced_login_method=\"chatgpt\"", "exec", "--json", "--color", "never",
          "--cd", "/workspace with spaces;$(no-shell)", "--sandbox", "workspace-write",
          "--output-last-message", join(root, "final.txt"), "--output-schema", join(root, "schema.json"),
          "--model", "gpt-5.6-codex", "-",
        ],
        cwd: "/workspace with spaces;$(no-shell)", stdin: "sanitized task",
      });
      const claude = claudeAdapter(service, { operationDirectory: root, environment: {} }).invocation(request(root, "claude"));
      expect(claude.executable).toBe("claude");
      expect(claude.args).toEqual([
        "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk",
        "--tools", "Read,Glob,Grep,Edit,Write", "--allowedTools", "Read,Glob,Grep,Edit,Write",
        "--disallowedTools", "mcp__*", "--json-schema", JSON.stringify(request(root, "claude").schema),
        "--model", "claude-sonnet-4-5",
      ]);
      expect(claude).not.toHaveProperty("shell");
    } finally { await service.dispose(); }
  });

  test("keeps read access native and requires an explicit qualified model", async () => {
    const root = await directory();
    const service = new ProcessService();
    try {
      const adapter = codexAdapter(service, { operationDirectory: root, environment: {} });
      const read = adapter.invocation({ ...request(root, "codex", false), access: "read" });
      expect(read.args).toContain("read-only");
      const { model: _model, ...withoutModel } = request(root, "codex");
      expect(() => adapter.invocation(withoutModel)).toThrow("CONFIG_UNVERIFIED");
    } finally { await service.dispose(); }
  });

  test("recognizes only qualified subscription statuses and names conflicting selectors without values", async () => {
    expect(decodeCodexAuth("Logged in using ChatGPT")).toBe("subscription");
    expect(decodeCodexAuth("Logged in using an API key")).toBe("other");
    expect(decodeClaudeAuth('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}')).toBe("subscription");
    expect(decodeClaudeAuth('{"loggedIn":true,"authMethod":"oauth"}')).toBe("other");
    const root = await directory();
    const service = new ProcessService();
    try {
      await expect(codexAdapter(service, {
        operationDirectory: root, environment: { OPENAI_API_KEY: "never-show-this" },
      }).status(new AbortController().signal)).rejects.toThrow("AUTH_CONFLICT: OPENAI_API_KEY");
      await expect(claudeAdapter(service, {
        operationDirectory: root, environment: { CLAUDE_CODE_USE_BEDROCK: "1" },
      }).status(new AbortController().signal)).rejects.toThrow("AUTH_CONFLICT: CLAUDE_CODE_USE_BEDROCK");
    } finally { await service.dispose(); }
  });

  test.each(["codex", "claude"] as const)("rejects %s subscription-shaped auth from a failed probe", async (provider) => {
    const root = await directory();
    const version = provider === "codex" ? "codex-cli 0.154.0" : "2.1.274 (Claude Code)";
    const auth = provider === "codex" ? "Logged in using ChatGPT"
      : '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}';
    const probe = (stdout: string, exitCode = 0): RunnerReturn => ({
      exitCode, signal: null, stdout, stderr: "", truncated: false,
    });
    const service = statusService(probe(version), probe(auth, 1));
    const adapter = provider === "codex"
      ? codexAdapter(service, { operationDirectory: root, environment: {} })
      : claudeAdapter(service, { operationDirectory: root, environment: {} });
    await expect(adapter.status(new AbortController().signal)).rejects.toThrow("AUTH_UNVERIFIED");
  });

  test.each(["codex", "claude"] as const)("rejects %s success without a provider-reported model", async (provider) => {
    const root = await directory();
    const stdout = join(root, "stdout.raw");
    if (provider === "codex") {
      await writeFile(stdout, '{"type":"turn.completed"}\n');
      await writeFile(join(root, "final.txt"), '{"ok":true}');
      await expect(decodeCodexResult(request(root, provider), await nativeEvidence(stdout, provider))).rejects.toThrow();
    } else {
      await writeFile(stdout, JSON.stringify({
        type: "result", subtype: "success", is_error: false, structured_output: { ok: true }, permission_denials: [],
      }));
      await expect(decodeClaudeResult(request(root, provider), await nativeEvidence(stdout, provider))).rejects.toThrow();
    }
  });

  test("strictly decodes successful Codex terminal JSONL and fresh final output", async () => {
    const root = await directory();
    const stdout = join(root, "stdout.raw");
    await writeFile(stdout, await readFile(new URL("fixtures/codex.jsonl", import.meta.url)));
    await writeFile(join(root, "final.txt"), '{"ok":true}');
    await expect(decodeCodexResult(request(root, "codex"), await nativeEvidence(stdout, "codex"))).resolves.toEqual({
      structured: { ok: true }, sessionId: "00000000-0000-4000-8000-000000000011", actualModel: "gpt-5.6-codex",
      usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 3 },
    });
    await writeFile(stdout, '{"type":"turn.completed"}\n{"type":"turn.failed"}\n');
    await expect(decodeCodexResult(request(root, "codex"), await nativeEvidence(stdout, "codex"))).rejects.toThrow();
    await writeFile(stdout, `${"x".repeat(2 * 1024 * 1024 + 1)}\n`);
    await expect(decodeCodexResult(request(root, "codex"), await nativeEvidence(stdout, "codex"))).rejects.toThrow("record exceeds 2 MiB");
  });

  test("strictly decodes Claude terminal envelopes, permission denials, models, and output bounds", async () => {
    const root = await directory();
    const stdout = join(root, "stdout.raw");
    await writeFile(stdout, await readFile(new URL("fixtures/claude.jsonl", import.meta.url)));
    await expect(decodeClaudeResult(request(root, "claude"), await nativeEvidence(stdout, "claude"))).resolves.toEqual({
      structured: { ok: true }, sessionId: "session-sanitized", actualModel: "claude-sonnet-4-5",
      usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 3 },
    });
    await expect(decodeClaudeResult({ ...request(root, "claude"), model: "different-model" }, await nativeEvidence(stdout, "claude")))
      .rejects.toThrow("MODEL_MISMATCH");
    await writeFile(stdout, JSON.stringify({
      type: "result", subtype: "success", is_error: false, structured_output: { ok: true }, permission_denials: ["Write"],
    }));
    await expect(decodeClaudeResult(request(root, "claude"), await nativeEvidence(stdout, "claude"))).rejects.toThrow();
    await writeFile(stdout, JSON.stringify({
      type: "result", subtype: "success", is_error: false, model: "claude-sonnet-4-5",
      result: "x".repeat(1024 * 1024 + 1), permission_denials: [],
    }));
    await expect(decodeClaudeResult(request(root, "claude", false), await nativeEvidence(stdout, "claude"))).rejects.toThrow();
  });
});
