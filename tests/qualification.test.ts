import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { canonicalJson, type Json } from "../src/contracts.js";
import { assertFoundationTarget, classifyDarwinProcessGroup, matchesDarwinGroupMemberIdentity, matchesDarwinProcessIdentity, runFoundationPhase, type FoundationEvidence, type FoundationOptions } from "../src/testing.js";
import { probeProcessGroup } from "../src/process.js";

const localTarget = process.platform === "darwin" ? "macos-github" : "linux-local";
const mismatchedTarget = localTarget === "linux-local" ? "macos-github" : "linux-local";

function forgeEvidence(evidence: FoundationEvidence, changes: Partial<FoundationEvidence>): FoundationEvidence {
  const { evidenceHash: _, ...current } = evidence;
  const unsigned = { ...current, ...changes };
  return {
    ...unsigned,
    evidenceHash: createHash("sha256").update(canonicalJson(unsigned as unknown as Json)).digest("hex"),
  };
}

function groupAlive(groupId: number): boolean {
  const state = probeProcessGroup(groupId);
  if (state === "unknown") throw new Error("Group presence could not be established");
  return state === "present";
}

function processAlive(processId: number): boolean {
  try { process.kill(processId, 0); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessAbsent(processId: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (processAlive(processId) && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
}

async function stopGroup(groupId: number): Promise<void> {
  try { process.kill(-groupId, "SIGKILL"); } catch {}
  const deadline = Date.now() + 5_000;
  while (groupAlive(groupId) && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
}

function cliOptions(): FoundationOptions | undefined {
  const target = option("target");
  const phase = option("phase");
  const scenario = option("scenario");
  const evidence = option("evidence");
  if (!target && !phase && !scenario && !evidence) return undefined;
  if (!(["linux-local", "macos-github"] as const).includes(target as never)
    || !(["prepare", "interrupt", "resume", "verify"] as const).includes(phase as never)
    || !(["process-interrupt", "reboot"] as const).includes(scenario as never)
    || !evidence) throw new Error("Usage: --target TARGET --phase PHASE --scenario SCENARIO --evidence PATH");
  return { target, phase, scenario, evidence } as FoundationOptions;
}

const cli = cliOptions();
if (cli) {
  const evidence = await runFoundationPhase(cli);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    target: evidence.target,
    scenario: evidence.scenario,
    status: evidence.status,
    identity: evidence.identity,
    stableLockExclusion: evidence.stableLockExclusion,
    processGroup: evidence.processGroup,
    counters: evidence.counters,
    evidenceHash: evidence.evidenceHash,
  })}\n`);
} else {
  const { describe, expect, test, vi } = await import("vitest");

  describe("foundation qualification", () => {
    test("runtime classes treat WSL2 as Linux and reserve reboot evidence for Linux", async () => {
      const linux = {
        platform: "linux",
        release: "5.15.153.1-microsoft-standard-WSL2",
        filesystem: { type: "0xef53", blockSize: 4_096, device: "1", format: "ext4" },
      };
      const macos = {
        platform: "darwin",
        release: "24.6.0",
        filesystem: { type: "0x1a", blockSize: 4_096, device: "1", format: "statfs-1a" },
      };

      expect(() => assertFoundationTarget("linux-local", linux, "process-interrupt")).not.toThrow();
      expect(() => assertFoundationTarget("linux-local", {
        ...linux,
        filesystem: { ...linux.filesystem, format: "fuse.sshfs" },
      }, "process-interrupt")).toThrow("FILESYSTEM_NOT_LOCAL");
      expect(() => assertFoundationTarget("wsl2-linux-fs", linux, "process-interrupt")).toThrow("TARGET_MISMATCH");
      expect(() => assertFoundationTarget("macos-github", macos, "process-interrupt")).not.toThrow();
      expect(() => assertFoundationTarget("macos-github", macos, "reboot"))
        .toThrow("GitHub-hosted jobs cannot provide a physical-reboot witness");
      await expect(runFoundationPhase({
        target: "macos-github",
        phase: "prepare",
        scenario: "reboot",
        evidence: ".coding-flow-qualification/rejected-macos-reboot.json",
      })).rejects.toThrow("GitHub-hosted jobs cannot provide a physical-reboot witness");
    });

    test("process interruption recovers synchronized evidence without resetting counters", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      let prepared: Awaited<ReturnType<typeof runFoundationPhase>> | undefined;
      try {
        prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence });
        const interrupted = await runFoundationPhase({ target: localTarget, phase: "interrupt", scenario: "process-interrupt", evidence });
        expect(interrupted.processGroup?.cleanup).toBe("absent");
        await expect(runFoundationPhase({ target: localTarget, phase: "resume", scenario: "process-interrupt", evidence }))
          .resolves.toMatchObject({ status: "resumed", counters: { prepare: 1, interrupt: 1, resume: 1, verify: 0 } });
        await expect(runFoundationPhase({ target: localTarget, phase: "verify", scenario: "process-interrupt", evidence }))
          .resolves.toMatchObject({ status: "passed", counters: { prepare: 1, interrupt: 1, resume: 1, verify: 1 } });
      } finally {
        if (prepared?.processGroup) try { process.kill(-prepared.processGroup.groupId, "SIGKILL"); } catch {}
        await rm(root, { recursive: true, force: true });
      }
    }, 20_000);

    test("unknown ownership never permits fallback hard-kill cleanup", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence });
      const signals = vi.spyOn(process, "kill");
      process.env.CODEFLOW_TEST_QUALIFICATION_GROUP_STATE = "unknown";
      try {
        await expect(runFoundationPhase({ target: localTarget, phase: "interrupt", scenario: "process-interrupt", evidence }))
          .rejects.toThrow("PROCESS_GROUP_ABSENCE_UNPROVED");
        expect(signals.mock.calls.some(([groupId, signal]) => groupId === -prepared.processGroup!.groupId && signal === "SIGKILL"))
          .toBe(false);
      } finally {
        delete process.env.CODEFLOW_TEST_QUALIFICATION_GROUP_STATE;
        signals.mockRestore();
        try { process.kill(-prepared.processGroup!.groupId, "SIGKILL"); } catch {}
        await rm(root, { recursive: true, force: true });
      }
    });

    test("an incomplete readiness marker cannot become ready or orphan its group", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      process.env.CODEFLOW_TEST_QUALIFICATION_MARKER = "incomplete";
      try {
        await expect(runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence }))
          .rejects.toThrow(/JSON/);
        const paths = await readdir(root, { recursive: true });
        const pidPath = paths.find((path) => path.endsWith("qualification-group.json.pid"));
        expect(pidPath).toBeDefined();
        const groupId = Number(await readFile(join(root, pidPath!), "utf8"));
        expect(groupAlive(groupId)).toBe(false);
        await expect(readFile(evidence)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        delete process.env.CODEFLOW_TEST_QUALIFICATION_MARKER;
        await rm(root, { recursive: true, force: true });
      }
    });

    test("concurrent prepare has one winner and creates no losing process group", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const groups: number[] = [];
      try {
        const outcomes = await Promise.allSettled([
          runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence }),
          runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence }),
        ]);
        const winners = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
        groups.push(...winners.flatMap((winner) => winner.processGroup ? [winner.processGroup.groupId] : []));
        expect(winners).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
        expect(await readdir(join(root, "workspaces"))).toHaveLength(1);
      } finally {
        await Promise.all(groups.map(stopGroup));
        await rm(root, { recursive: true, force: true });
      }
    });

    test("mismatched and corrupt evidence cannot advance", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence });
      try {
        const before = await readFile(evidence, "utf8");
        await expect(runFoundationPhase({ target: mismatchedTarget, phase: "interrupt", scenario: "process-interrupt", evidence }))
          .rejects.toThrow("QUALIFICATION_IDENTITY_MISMATCH");
        expect(await readFile(evidence, "utf8")).toBe(before);
        const parsed = JSON.parse(before);
        parsed.counters.prepare = 2;
        await writeFile(evidence, JSON.stringify(parsed));
        await expect(runFoundationPhase({ target: localTarget, phase: "interrupt", scenario: "process-interrupt", evidence }))
          .rejects.toThrow("INVALID_QUALIFICATION_EVIDENCE");
      } finally {
        if (prepared.processGroup) try { process.kill(-prepared.processGroup.groupId, "SIGKILL"); } catch {}
        await rm(root, { recursive: true, force: true });
      }
    });

    test("reboot evidence cannot resume during the preparing boot", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "reboot.json"));
      try {
        if (localTarget === "macos-github") {
          await expect(runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "reboot", evidence }))
            .rejects.toThrow("GitHub-hosted jobs cannot provide a physical-reboot witness");
          return;
        }
        await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "reboot", evidence });
        await expect(runFoundationPhase({ target: localTarget, phase: "resume", scenario: "reboot", evidence }))
          .rejects.toThrow("REBOOT_NOT_OBSERVED");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("stale but correctly signed evidence cannot advance", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const preparedAt = new Date("2026-01-01T00:00:00.000Z");
      const prepared = await runFoundationPhase({
        target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence, now: () => preparedAt,
      });
      try {
        const later = new Date(preparedAt.getTime() + 8 * 24 * 60 * 60 * 1_000);
        await expect(runFoundationPhase({
          target: localTarget, phase: "interrupt", scenario: "process-interrupt", evidence, now: () => later,
        }))
          .rejects.toThrow("STALE_QUALIFICATION_EVIDENCE");
        expect(groupAlive(prepared.processGroup!.groupId)).toBe(false);
      } finally {
        if (prepared.processGroup) try { process.kill(-prepared.processGroup.groupId, "SIGKILL"); } catch {}
        await rm(root, { recursive: true, force: true });
      }
    });

    test("durable state rejects a re-signed prepared boot mutation and reaps the group", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence });
      try {
        await writeFile(evidence, `${JSON.stringify(forgeEvidence(prepared, { preparedBootId: `forged-${prepared.preparedBootId}` }))}\n`);
        await expect(runFoundationPhase({ target: localTarget, phase: "interrupt", scenario: "process-interrupt", evidence }))
          .rejects.toThrow("QUALIFICATION_STATE_MISMATCH");
        expect(groupAlive(prepared.processGroup!.groupId)).toBe(false);
      } finally {
        if (prepared.processGroup) await stopGroup(prepared.processGroup.groupId);
        await rm(root, { recursive: true, force: true });
      }
    });

    test("re-signed reboot boot mutation cannot manufacture a reboot", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "reboot.json"));
      try {
        if (localTarget === "macos-github") {
          await expect(runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "reboot", evidence }))
            .rejects.toThrow("GitHub-hosted jobs cannot provide a physical-reboot witness");
          return;
        }
        const prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "reboot", evidence });
        await writeFile(evidence, `${JSON.stringify(forgeEvidence(prepared, { preparedBootId: `forged-${prepared.preparedBootId}` }))}\n`);
        await expect(runFoundationPhase({ target: localTarget, phase: "resume", scenario: "reboot", evidence }))
          .rejects.toThrow("QUALIFICATION_STATE_MISMATCH");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("durable state rejects a re-signed checkpoint sequence forgery before mutation", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence });
      try {
        const forged = forgeEvidence(prepared, {
          checkpoints: [{ phase: "verify", timestamp: prepared.createdAt, previousEvidenceHash: "0".repeat(64) }],
        });
        await writeFile(evidence, `${JSON.stringify(forged)}\n`);
        const before = await readFile(evidence, "utf8");
        await expect(runFoundationPhase({ target: localTarget, phase: "interrupt", scenario: "process-interrupt", evidence }))
          .rejects.toThrow("QUALIFICATION_STATE_MISMATCH");
        expect(await readFile(evidence, "utf8")).toBe(before);
        expect(groupAlive(prepared.processGroup!.groupId)).toBe(false);
      } finally {
        if (prepared.processGroup) await stopGroup(prepared.processGroup.groupId);
        await rm(root, { recursive: true, force: true });
      }
    });

    test("Darwin process identity requires matching leader, group, and nonce", () => {
      const nonce = "00000000-0000-4000-8000-000000000123";
      expect(matchesDarwinProcessIdentity(` 42 42 /usr/local/bin/node fixture.mjs qualification-hang marker ${nonce} atomic\n`, 42, nonce)).toBe(true);
      expect(matchesDarwinProcessIdentity(` 41 42 /usr/local/bin/node fixture.mjs ${nonce}\n`, 42, nonce)).toBe(false);
      expect(matchesDarwinProcessIdentity(` 42 41 /usr/local/bin/node fixture.mjs ${nonce}\n`, 42, nonce)).toBe(false);
      expect(matchesDarwinProcessIdentity(" 42 42 /usr/local/bin/node fixture.mjs different-nonce\n", 42, nonce)).toBe(false);
      expect(matchesDarwinProcessIdentity("not ps output", 42, nonce)).toBe(false);
      expect(matchesDarwinProcessIdentity(`42 42 /usr/local/bin/node fixture.mjs ${nonce}\n99 99 /bin/other\n`, 42, nonce)).toBe(false);
      expect(matchesDarwinGroupMemberIdentity(`99 42 /usr/local/bin/node fixture.mjs qualification-grandchild ${nonce}\n`, 42, nonce)).toBe(true);
      expect(matchesDarwinGroupMemberIdentity(`42 42 /usr/local/bin/node fixture.mjs ${nonce}\n99 42 /usr/local/bin/node fixture.mjs qualification-grandchild ${nonce}\n`, 42, nonce)).toBe(true);
      expect(matchesDarwinGroupMemberIdentity(`99 42 /usr/local/bin/node fixture.mjs prefix-${nonce}-suffix\n`, 42, nonce)).toBe(false);
      expect(matchesDarwinGroupMemberIdentity(`99 42 /usr/local/bin/node fixture.mjs ${nonce}\nmalformed\n`, 42, nonce)).toBe(false);
      expect(matchesDarwinGroupMemberIdentity(`99 41 /usr/local/bin/node fixture.mjs ${nonce}\n`, 42, nonce)).toBe(false);
      expect(classifyDarwinProcessGroup("", 42, nonce)).toBe("unknown");
      expect(classifyDarwinProcessGroup("99 99 /sbin/launchd\n", 42, nonce)).toBe("absent");
      expect(classifyDarwinProcessGroup(`99 42 /usr/local/bin/node fixture.mjs ${nonce}\n`, 42, nonce)).toBe("present");
      expect(classifyDarwinProcessGroup("99 42 /usr/local/bin/node fixture.mjs different-nonce\n", 42, nonce)).toBe("unknown");
      expect(classifyDarwinProcessGroup("not ps output", 42, nonce)).toBe("unknown");
    });

    test("an absent group before interrupt cannot produce passing evidence", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence });
      try {
        await stopGroup(prepared.processGroup!.groupId);
        const before = await readFile(evidence, "utf8");
        await expect(runFoundationPhase({ target: localTarget, phase: "interrupt", scenario: "process-interrupt", evidence }))
          .rejects.toThrow("PROCESS_INTERRUPT_NOT_OBSERVED");
        expect(await readFile(evidence, "utf8")).toBe(before);
      } finally {
        if (prepared.processGroup) await stopGroup(prepared.processGroup.groupId);
        await rm(root, { recursive: true, force: true });
      }
    });

    test("failure cleanup reaps an owned group after its leader exits", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence });
      const marker = JSON.parse(await readFile(join(prepared.workspace, "qualification-group.json"), "utf8")) as { childPid: number };
      try {
        const before = await readFile(evidence, "utf8");
        process.kill(prepared.processGroup!.groupId, "SIGKILL");
        await waitForProcessAbsent(prepared.processGroup!.groupId);
        expect(processAlive(prepared.processGroup!.groupId)).toBe(false);
        expect(processAlive(marker.childPid)).toBe(true);
        expect(groupAlive(prepared.processGroup!.groupId)).toBe(true);
        await expect(runFoundationPhase({ target: mismatchedTarget, phase: "interrupt", scenario: "process-interrupt", evidence }))
          .rejects.toThrow("QUALIFICATION_IDENTITY_MISMATCH");
        expect(await readFile(evidence, "utf8")).toBe(before);
        await waitForProcessAbsent(marker.childPid);
        expect(processAlive(marker.childPid)).toBe(false);
        expect(groupAlive(prepared.processGroup!.groupId)).toBe(false);
      } finally {
        if (prepared.processGroup) await stopGroup(prepared.processGroup.groupId);
        await rm(root, { recursive: true, force: true });
      }
    }, 20_000);

    test("copied prepared evidence cannot create a second lineage and leaves no group", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const first = relative(process.cwd(), join(root, "first.json"));
      const second = relative(process.cwd(), join(root, "second.json"));
      const prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence: first });
      try {
        await copyFile(first, second);
        await expect(runFoundationPhase({ target: localTarget, phase: "interrupt", scenario: "process-interrupt", evidence: second }))
          .rejects.toThrow("QUALIFICATION_LINEAGE_MISMATCH");
        expect(groupAlive(prepared.processGroup!.groupId)).toBe(false);
      } finally {
        if (prepared.processGroup) await stopGroup(prepared.processGroup.groupId);
        await rm(root, { recursive: true, force: true });
      }
    });

    test("one transition lease prevents concurrent resume counter loss", async () => {
      const root = await mkdtemp(join(process.cwd(), ".qualification-test-"));
      const evidence = relative(process.cwd(), join(root, "process.json"));
      const prepared = await runFoundationPhase({ target: localTarget, phase: "prepare", scenario: "process-interrupt", evidence });
      try {
        await runFoundationPhase({ target: localTarget, phase: "interrupt", scenario: "process-interrupt", evidence });
        const outcomes = await Promise.allSettled([
          runFoundationPhase({ target: localTarget, phase: "resume", scenario: "process-interrupt", evidence }),
          runFoundationPhase({ target: localTarget, phase: "resume", scenario: "process-interrupt", evidence }),
        ]);
        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        expect(JSON.parse(await readFile(evidence, "utf8")).counters.resume).toBe(1);
      } finally {
        if (prepared.processGroup) await stopGroup(prepared.processGroup.groupId);
        await rm(root, { recursive: true, force: true });
      }
    });
  });
}
