# Program Design: Codeflow

## User-directed amendment — 2026-09-12

The standalone pre-build reject/approve feasibility ceremony is removed. Slice 1 is satisfied
by the observed native Codex nested run through the verified `chatgpt-subscription` route,
with no API fallback. The spike files and the later detailed Slice 1 conversation below are
superseded and are not product deliverables. Real human consent, reconnection, and both-host
acceptance remain product behavior and are implemented and qualified in Slices 9–11.

## Files
- `package.json` — package exports, lifecycle CLI, exact scripts, engine constraints, and dependencies.
- `package-lock.json` — exact resolved production and test dependency versions.
- `tsconfig.json` — strict NodeNext authoring, test typechecking, declarations, and no-emit verification.
- `eslint.config.js` — TypeScript rules, including mandatory floating/misused-promise checks for flow sources.
- `.gitignore` — ignore runtime `.coding-flow/` state and local test outputs only.
- `compatibility.json` — exact qualified engine/runtime/dependency/provider/platform combinations and fixture hash.
- `.agents/skills/codeflow-feasibility/SKILL.md` — minimal Codex-host spike wrapper that presents evidence and relays the person's actual answer.
- `.claude/skills/codeflow-feasibility/SKILL.md` — equivalent minimal Claude-host spike wrapper with unchanged probe behavior.
- `spikes/native-host/probe.mjs` — standalone Node standard-library probe for native login route, nested structured task, authorized fixture edit, and reconnect token; it does not depend on the future engine.
- `spikes/native-host/result.schema.json` — strict provider-neutral result shape for both native probes.
- `spikes/native-host/fixture/target.txt` — disposable edit target whose exact before/after bytes prove the authorized native edit.
- `spikes/native-host/results/.gitkeep` — keeps the result-artifact directory while generated qualification results remain untracked.
- `.smtc/analyzers/codeflow-artifact-before-event.yaml` — reusable proof that durable artifact publication dominates an event reference.
- `.smtc/analyzers/codeflow-authorization-before-execution.yaml` — reusable proof that durable authorization dominates target execution.
- `.smtc/analyzers/codeflow-commit-before-delivery.yaml` — reusable proof that outcome commit dominates delivery to flow code.
- `.smtc/analyzers/codeflow-freshness-before-prepare.yaml` — reusable proof that workspace freshness dominates attempt preparation.
- `.smtc/analyzers/codeflow-limits-before-prepare.yaml` — reusable proof that limit reservation dominates attempt preparation.
- `.smtc/analyzers/codeflow-validation-before-state-use.yaml` — reusable proof that receiver validation dominates inbound state use.
- `.smtc/analyzers/codeflow-provider-preflight-before-dispatch.yaml` — reusable proof that provider preflight dominates invocation construction.
- `.smtc/analyzers/codeflow-cleanup-before-commit.yaml` — reusable proof that group-absence confirmation dominates outcome commit.
- `.smtc/analyzers/codeflow-approval-before-effect.yaml` — reusable proof that a committed-opened approval guard dominates an approved effect.
- `.smtc/controls/codeflow/unsafe/control.ts` — durable shared positive control with one reversed call pair for every analyzer.
- `.smtc/controls/codeflow/safe/control.ts` — durable shared negative control with every call pair in the required order.
- `src/sdk.ts` — public author interface: flow declaration, context primitives, prompts, contracts, limits, and artifacts.
- `src/host.ts` — public host interface: start/open/resume/recovery/list, run boundaries, replies, cancellation, and errors.
- `src/testing.ts` — public deterministic harness and crash/fake-provider controls.
- `src/contracts.ts` — JSON, Zod purity/portability, protocol-envelope, reply, artifact, and error validation.
- `src/prompts.ts` — prompt interpolation, canonical JSON insertion, instruction loading, and byte limits.
- `src/build.ts` — bounded flow compilation, import restrictions, pinned bundle/source graph, and executable identity.
- `src/artifacts.ts` — bounded streaming, hash/size/type verification, immutable sync-and-rename publication.
- `src/journal.ts` — hash-linked event append, verified recovery, deterministic reduction, and rebuildable projections.
- `src/ownership.ts` — stable kernel lock, installation identity, ownership generations, and conservative old-group checks.
- `src/process.ts` — the one shared registered process-group manager, bounded streams, signals, cleanup, and absence probes.
- `src/runner.ts` — inert-runner handshake, one-use authorization, target launch, raw evidence, and group cleanup.
- `src/worker.ts` — guarded flow loading, context primitives, original contract validation, trace generation, and pure reconstruction.
- `src/supervisor.ts` — authoritative state machine, admission, budgets, transaction ordering, worker/runner coordination, and terminal commit.
- `src/replay.ts` — boundary matching, committed-outcome replay, frontier selection, and mismatch diagnosis.
- `src/workspace.ts` — whole-workspace manifests, protected/disposable paths, stable scanning, baselines, and diff evidence.
- `src/human.ts` — presentation snapshots, question/approval requests, reply identity/deduplication, and durable receipts.
- `src/recovery.ts` — interrupted-effect classification, permitted recovery choices, evidence-bound revisions, and abandonment.
- `src/adapters/types.ts` — the single internal provider seam shared by both real adapters and test fixtures.
- `src/adapters/codex.ts` — qualified Codex status, exact invocation, bounds, terminal decoding, and auth-route checks.
- `src/adapters/claude.ts` — qualified Claude status, exact invocation, tool restrictions, bounds, terminal decoding, and auth-route checks.
- `src/cli.ts` — strict lifecycle argument parsing, JSON stdin/file handling, bounded waits, exit codes, and machine-readable output.
- `src/install.ts` — collision-safe thin Codex/Claude skill wrappers that keep business logic in the shared flow.
- `tests/contracts.test.ts` — invalid input/output/schema, JSON/prompt limits, exhaustive protocol rejection, and type-fixture driver.
- `tests/storage.test.ts` — artifact/event ordering, short writes, fsync/rename/append failures, corruption, views, and storage bounds.
- `tests/ownership-process.test.ts` — concurrent owners, real process groups, parent/runner death, grandchildren, cancellation, and PID reuse.
- `tests/execution-replay.test.ts` — branching, nesting, serial discipline, committed replay, mismatches, budgets, and finalization.
- `tests/workspace.test.ts` — manifests, external/self edits, symlinks, unstable scans, protected/disposable paths, and limits.
- `tests/human-recovery.test.ts` — evidence publication, questions, consent freshness, reply deduplication, deadlines, and unknown effects.
- `tests/adapters.test.ts` — sanitized Codex/Claude status and terminal fixtures, auth conflicts, bounds, and permission/model failures.
- `tests/cli-install.test.ts` — lifecycle commands, exit codes, wrapper collision safety, discovery, reconnection, and pruning.
- `tests/crash-matrix.test.ts` — every required crash point in a fresh supervisor with effect/state/evidence/budget assertions.
- `tests/qualification.test.ts` — opt-in platform, filesystem, installation, provider, and both-host qualification that writes `compatibility.json` only after full success.
- `tests/types/positive.ts` — compiling public author examples and inferred input/output types.
- `tests/types/negative.ts` — expected compile failures for invalid use and forbidden asynchronous authoring patterns.
- `tests/fixtures/codex.jsonl` — sanitized bounded Codex success/failure/protocol records.
- `tests/fixtures/claude.json` — sanitized bounded Claude success/failure/protocol envelopes.
- `tests/fixtures/process-child.mjs` — deterministic descendant, signal, output, and orphan behavior for real process tests.
- `tests/fixtures/host-flow.ts` — smallest real host flow covering structured output, edit, presentation, reply, and reconnection.
- `README.md` — install, provider login, doctor, first flow, support matrix, runtime-state retention, and recovery guidance.
- `docs/codebase-overview.md` — refresh repository shape and verified commands after the implementation exists.

No separate database, daemon, dependency-injection container, provider SDK, retry framework, graph language, or second persistence implementation is planned.

## Types & signatures
The normative public declarations in `SPEC.md` remain authoritative. These signatures fix module ownership and the internal seams needed for deterministic and fault-injection tests; implementations stay private.

```ts
// src/sdk.ts
export type Json = null | boolean | number | string |
  readonly Json[] | { readonly [key: string]: Json };
export type Provider = "codex" | "claude";
export type Access = "read" | "write";
export interface FlowDefinition<I, O> {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  readonly limits?: Limits;
  readonly disposablePaths?: readonly string[];
  readonly run: (context: FlowContext<I>) => Promise<O>;
}
export declare function flow<I, O>(definition: FlowDefinition<I, O>): Flow<I, O>;
export interface FlowContext<I> {
  readonly input: Readonly<I>;
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly agent: Agent;
  readonly human: Human;
  command(executable: string, args?: readonly string[], options?: CommandOptions): Promise<CommandResult>;
  read(path: string): Promise<string>;
  phase<T>(name: string, body: () => Promise<T>): Promise<T>;
  skill<A, B>(child: Flow<A, B>, input: A): Promise<B>;
  check(condition: boolean, message: string): void;
  log(message: string, data?: Json): void;
}
export declare function prompt(strings: TemplateStringsArray, ...values: readonly unknown[]): string;
```

```ts
// src/host.ts
export type RunBoundary = RunSummary & (
  | { readonly status: "starting" | "running" | "recovering" }
  | { readonly status: "waiting-for-human"; readonly request: HumanRequest }
  | { readonly status: "interrupted"; readonly lastCommittedSequence: number }
  | { readonly status: "blocked"; readonly reason: BlockCode; readonly message: string; readonly evidence: readonly ArtifactRef[] }
  | { readonly status: "succeeded"; readonly output: Json; readonly outputArtifact: ArtifactRef }
  | { readonly status: "failed" | "cancelled" | "timed-out"; readonly error: FlowErrorData }
);
export interface RunHandle {
  readonly runId: string;
  wait(timeoutMs?: number): Promise<RunBoundary>;
  respond(reply: HumanReply): Promise<ReplyReceipt>;
  cancel(reason?: string): Promise<RunBoundary>;
}
export declare function startFlow(entry: URL, rawInput: unknown, options: RunOptions): Promise<RunHandle>;
export declare function openRun(workspace: string, runId: string): Promise<RunHandle>;
export declare function resumeRun(workspace: string, runId: string): Promise<RunHandle>;
export declare function inspectRecovery(workspace: string, runId: string): Promise<RunBoundary>;
export declare function listRuns(workspace: string): Promise<readonly RunBoundary[]>;
```

```ts
// internal durable/process seams
export interface Clock {
  monotonicMs(): number;
  wallIso(): string;
}
export interface RunStore {
  publishArtifact(input: AsyncIterable<Uint8Array>, policy: ArtifactPolicy): Promise<ArtifactRef>;
  append(event: UncommittedEvent): Promise<CommittedEvent>;
  readVerified(runId: string): Promise<readonly CommittedEvent[]>;
  rebuildViews(runId: string, history: readonly CommittedEvent[]): Promise<void>;
}
export interface WorkspaceEvidence {
  capture(root: string, policy: WorkspacePolicy): Promise<WorkspaceManifest>;
  assertFresh(expected: WorkspaceManifest): Promise<void>;
  diff(expected: WorkspaceManifest, actual: WorkspaceManifest): Promise<ArtifactRef>;
}
export interface ProcessService {
  register(request: ProcessRequest): Promise<RegisteredProcess>;
  authorizeTarget(process: RegisteredProcess, authorization: Authorization): Promise<RunnerReturn>;
  terminate(process: RegisteredProcess, reason: string): Promise<CleanupResult>;
  assertGroupAbsent(identity: ProcessIdentity): Promise<void>;
}
export interface Ownership {
  acquire(workspace: string): Promise<OwnershipLease>;
  inspectOldGroups(history: readonly CommittedEvent[]): Promise<void>;
}
```

```ts
// exact ordered-operation names targeted by Gate 3 analyzer specs
export declare function publishEventWithArtifacts(store: RunStore, draft: EventDraft): Promise<CommittedEvent>;
export declare function authorizeAttempt(context: AttemptContext): Promise<RunnerReturn>;
export declare function commitOutcomeAndDeliver(context: CommitContext): Promise<void>;
export declare function admitExternalOperation(context: AdmissionContext): Promise<PreparedAttempt>;
export declare function applyInboundMessage(context: InboundContext, raw: unknown): Promise<void>;
export declare function dispatchProvider(context: ProviderContext): Promise<RunnerReturn>;
export declare function completeRunner(context: RunnerContext, returned: RunnerReturn): Promise<void>;
export declare function dispatchApprovedEffect(context: ApprovalContext): Promise<CommittedOutcome>;
```

The required call names inside those functions are fixed and unique for executable ordering checks: `publishArtifact` before `appendEventWithArtifacts`; `commitAuthorization` before `authorizeTarget`; `assertGroupAbsent` then `commitOutcome` before `deliverOutcome`; `assertFresh` and `reserveLimits` before `prepareAttempt`; `validateEnvelope` before `applyMessage`; `preflightProvider` before pure `buildProviderInvocation`; and `requireCommittedApprovalGateOpened` plus `assertFresh` before `authorizeApprovedEffect`.

```ts
// provider seam
export interface Adapter {
  status(signal: AbortSignal): Promise<RuntimeStatus>;
  invocation(request: ProviderRequest): ProcessInvocation;
  decode(request: ProviderRequest, returned: RunnerReturn): Promise<ProviderResult>;
}
export declare function codexAdapter(processes: ProcessService, qualification: Qualification): Adapter;
export declare function claudeAdapter(processes: ProcessService, qualification: Qualification): Adapter;
```

## Call stack
### Start and one external primitive
1. `startFlow` launches a detached run-scoped supervisor with a private startup channel and waits for its bounded handshake; the launcher never owns or transfers the workspace lock.
2. `Supervisor.start` → `Ownership.acquire` and retain the lock descriptor for the supervisor lifetime → publish immutable manifest/raw-input artifact → `RunStore.append(run.created)` → return the startup handshake with its durable run ID. No authoritative write occurs before the supervisor owns the lock; launcher exit does not release it.
3. Under the fixed initialization deadline: `buildFlow` → `validateFlowAndInput` → `WorkspaceEvidence.capture` → `RunStore.append(run.initialized)`. Initialization charges accumulate against the root limits.
4. `Worker.run` → one context primitive → `Supervisor.handleBoundary`.
5. `Supervisor.handleBoundary` → `admitExternalOperation` (`assertFresh` → `reserveLimits` → `prepareAttempt`).
6. Provider path only: `dispatchProvider` (`preflightProvider` → pure `buildProviderInvocation` → `authorizeAttempt`); command path builds an argv request and enters the same `authorizeAttempt` without a provider adapter.
7. `authorizeAttempt` → `ProcessService.register` → `RunStore.append(dispatch.authorized)` through `commitAuthorization` → `ProcessService.authorizeTarget`.
8. Runner → target process group → bounded raw artifacts → `RunnerReturn`.
9. `completeRunner` → preliminary `ProcessService.assertGroupAbsent` → post-workspace capture → worker original-contract validation.
10. `commitOutcomeAndDeliver` → final `ProcessService.assertGroupAbsent` → `RunStore.append(operation.committed)` through `commitOutcome` → `deliverOutcome` to the worker.

### Human question or approval
1. Worker `human.present/ask/approve` → supervisor boundary.
2. `publishEventWithArtifacts` publishes immutable evidence before the supervisor commits the request.
3. Host displays the exact request and evidence → creates one submission identity → `respond` writes one atomic inbox envelope.
4. Supervisor `applyInboundMessage` → `validateEnvelope` → historical submission/semantic lookup → active revision/schema checks → commit reply decision/receipt before continuation.
5. Approval only: reconstruct to the same request → validate workspace/watch freshness → `commitApprovalGateOpened` (or commit denied/stale) → `deliverApprovalGateOutcome` to author code. A crash between the reply decision and gate outcome resumes this sequence without opening work early.
6. Before the callback's first external effect: `dispatchApprovedEffect` → `requireCommittedApprovalGateOpened` → fresh workspace/watch check → `authorizeApprovedEffect`; a second external boundary is rejected before dispatch.

### Resume and unresolved effect
1. `resumeRun` → `Ownership.acquire` → `RunStore.readVerified` → verify referenced artifacts, installation/path, pinned bundle/executable/runtime identity, and history-derived process identities.
2. `Ownership.inspectOldGroups(verifiedHistory)` → durably increment ownership generation → restore reduced state and current workspace evidence. Corrupt/unverified history causes no signal, dispatch, or generation increment.
3. `Replay.reconstruct` starts a fresh guarded worker from the pinned bundle and feeds committed outcomes until the durable frontier.
4. A complete, validated returned candidate with matching baseline commits automatically; a committed outcome replays with zero dispatch.
5. An authorized attempt without sufficient return/baseline evidence → `Recovery.inspect` → immutable recovery presentation → eligible `accept-return`, `retry-no-application`, or `abandon` request.
6. A retry decision creates exactly one linked new attempt after fresh ownership, evidence, limits, authentication, and permission checks; the old unknown attempt remains historical truth.

### Finalization and cancellation
1. Worker returns candidate output → original output contract validation → history-frontier and sticky-failure checks.
2. Stop worker/guardian → prove all registered groups absent → verify workspace evidence → publish output artifact → commit terminal event → return success.
3. Cancellation → stop new admission → terminate live owned group through its channel → bounded escalation → absence proof → commit cancellation; uncertain cleanup remains blocked, not successful cancellation.

## Test plan
- `native_host_feasibility_requires_unmodified_subscription_route` — both intended hosts prove login route, nested task, structured result, authorized edit, actual human round-trip, and reconnection without bypasses before full build.
- `run_created_precedes_startup_identity_and_survives_initialization_crash` — no run ID is returned before durable creation; a crash after creation retains immutable input/identity and initialization charges for recovery.
- `foundation_matrix_rejects_unqualified_platform` — native addon, stable lock, sync/rename/append behavior, process groups, parent loss, and reused-ID-safe probes must all pass for a platform/filesystem entry.
- `invalid_input_runs_no_author_effect` and `portable_contracts_reject_unsupported_shapes` — external values are validated before control or effects.
- `artifact_is_durable_before_referencing_event` and `corrupt_or_missing_committed_evidence_blocks` — journal truth never outruns its evidence.
- `authorization_is_committed_before_target_spawn` — inert runner cannot execute before its exact one-use durable authorization.
- `committed_outcome_precedes_worker_delivery` — author code cannot observe an outcome absent from durable replay history.
- `two_supervisors_have_one_journal_writer` and `recovery_never_signals_reused_group_id` — ownership and cleanup remain conservative.
- `launcher_exit_does_not_release_supervisor_ownership` — after the startup handshake and launcher exit, a second claimant remains blocked while the detached supervisor retains the lock.
- `crash_matrix_preserves_effect_count_state_evidence_budget_and_decision` — every required crash location runs in a fresh process and proves the correct no-dispatch, replay, or unknown result.
- `committed_operations_redispatch_zero_times` and `trace_or_code_or_workspace_mismatch_blocks_before_frontier` — replay is exact and conservative.
- `external_workspace_edit_invalidates_old_result` and `committed_self_edit_replays_against_its_post_baseline` — evidence freshness distinguishes outside edits from recorded effects.
- `reply_dedup_checks_history_before_current_request` — duplicate decision A after question B, terminal completion, and restart returns its historical receipt with zero callback/effect replay.
- `approval_requires_fresh_evidence_and_allows_one_external_boundary` — rejection, expiry, staleness, or a second operation dispatches nothing unauthorized.
- `reply_decision_and_approval_gate_survive_each_intermediate_crash` — decision commit, gate freshness, opened/denied/stale outcome commit, author delivery, and first callback effect remain distinct and replay safely.
- `unknown_effect_offers_only_evidence_eligible_recovery_choices` — no missing outcome becomes success/failure and no retry occurs without explicit attestation.
- `limits_and_deadlines_never_reset_after_crash_or_reboot` — counts, storage, active grants, and offline human expiry remain cumulative.
- `provider_decoders_require_qualified_terminal_success` — malformed/truncated/conflicting output, auth ambiguity, denial, model mismatch, or missing structured result cannot become success.
- `cli_and_wrappers_preserve_machine_boundaries_and_run_identity` — strict flags, JSON I/O, lifecycle exit codes, collision-safe installation, discovery, attach/resume, and pruning behave exactly.
- `public_examples_typecheck_and_negative_usage_fails` — package declarations infer correct inputs/outputs and reject forbidden author patterns.
- `release_qualification_requires_both_hosts_and_exact_compatibility_record` — support is published only for combinations that pass every required gate.

Gate 4's first witness runs from inside each matching host wrapper, before package implementation. The probe is a durable three-command conversation; every command is a fresh process reading the same state file:

```text
node spikes/native-host/probe.mjs start --provider codex --state spikes/native-host/results/codex-state.json --request spikes/native-host/results/codex-reject-request.json
node spikes/native-host/probe.mjs respond --state spikes/native-host/results/codex-state.json --reply spikes/native-host/results/codex-reject-reply.json --next-request spikes/native-host/results/codex-approve-request.json
node spikes/native-host/probe.mjs status --state spikes/native-host/results/codex-state.json
node spikes/native-host/probe.mjs respond --state spikes/native-host/results/codex-state.json --reply spikes/native-host/results/codex-approve-reply.json --result spikes/native-host/results/codex.json

node spikes/native-host/probe.mjs start --provider claude --state spikes/native-host/results/claude-state.json --request spikes/native-host/results/claude-reject-request.json
node spikes/native-host/probe.mjs respond --state spikes/native-host/results/claude-state.json --reply spikes/native-host/results/claude-reject-reply.json --next-request spikes/native-host/results/claude-approve-request.json
node spikes/native-host/probe.mjs status --state spikes/native-host/results/claude-state.json
node spikes/native-host/probe.mjs respond --state spikes/native-host/results/claude-state.json --reply spikes/native-host/results/claude-approve-reply.json --result spikes/native-host/results/claude.json
```

`start` proves the native login route and nested structured task, durably records the logical probe identity, and exits `10` with the rejection request. The wrapper must display that request, obtain the person's actual rejection, and write the exact reply JSON; it never invents an answer. The first `respond` validates the request/reply identity, proves effect count `0`, durably advances state, and exits `10` with a separate approval request. After the wrapper displays that request and writes the person's actual affirmative reply, `status` proves a fresh process can reconnect to the same pending identity; the final `respond` validates the current revision, performs exactly one authorized fixture edit, verifies its bytes, and writes the terminal result.

Waiting commands exit `10`; `status` exits `10` while pending; the final accepted `respond` exits `0`. The final artifact must validate against `spikes/native-host/result.schema.json` and contain the exact host/provider version, recognized subscription route, nested run identity, structured-result hash, fixture before/after hashes, both human request/reply identities, rejection effect count `0`, acceptance effect count `1`, and reconnection outcome. The two result artifacts are test evidence, not product dependencies. Gate 4 must stop after Slice 1 if either host cannot produce its artifact without changing native restrictions.

Direct commands will be fixed at Gate 4 after package scripts exist in the approved file plan. Every typed-source slice will run the project typechecker in addition to its behavior witness.

## Invariants & spec dispositions
The following repeated, load-bearing call-order invariants are candidates for `sf-spec-authoring`; Gate 3 is not approvable until each row records `KEEP`, `REJECT`, or `UNKNOWN`, and every `KEEP` names its YAML path, retained unsafe control root, and slice witness.

| Invariant | Candidate analyzer | Current disposition |
|---|---|---|
| Artifact publication precedes any journal event that references it. | `artifact-before-event` | `KEEP` — `.smtc/analyzers/codeflow-artifact-before-event.yaml`; shared unsafe control `.smtc/controls/codeflow/unsafe` fired once and shared safe control `.smtc/controls/codeflow/safe` returned zero; Slice 4 runs it against product root `src`. |
| Durable authorization precedes target execution. | `authorization-before-execution` | `KEEP` — `.smtc/analyzers/codeflow-authorization-before-execution.yaml`; shared durable controls returned one/zero; Slice 5 runs it against `src`. |
| Durable outcome commit precedes delivery to flow code. | `commit-before-delivery` | `KEEP` — `.smtc/analyzers/codeflow-commit-before-delivery.yaml`; shared durable controls returned one/zero; Slice 7 runs it against `src`. |
| Workspace freshness and limit reservation precede external attempt preparation. | `admission-before-prepare` | `KEEP` as two obligations — `.smtc/analyzers/codeflow-freshness-before-prepare.yaml` and `.smtc/analyzers/codeflow-limits-before-prepare.yaml`; shared durable controls returned one/zero for each; Slice 7 runs both against `src`. |
| Receiver validation precedes application of an inbound message. | `validation-before-state-use` | `KEEP` — `.smtc/analyzers/codeflow-validation-before-state-use.yaml`; shared durable controls returned one/zero; Slice 9 runs it against `src`. |
| Qualified provider preflight precedes provider invocation construction; actual execution uses the single durable authorization path. | `provider-preflight-before-dispatch` | `KEEP` — `.smtc/analyzers/codeflow-provider-preflight-before-dispatch.yaml`; `preflightProvider` dominates pure `buildProviderInvocation`; shared durable controls returned one/zero; behavioral adapter/process tests own later execution; Slice 10 runs it against `src`. |
| Process-group absence is proved before an operation outcome is committed. | `cleanup-before-commit` | `KEEP` — `.smtc/analyzers/codeflow-cleanup-before-commit.yaml`; shared durable controls returned one/zero; Slice 5 runs it against `src`. |
| A committed opened approval gate and fresh evidence precede an approved external effect. | `approval-before-effect` | `KEEP` — `.smtc/analyzers/codeflow-approval-before-effect.yaml`; `requireCommittedApprovalGateOpened` dominates `authorizeApprovedEffect`; shared durable controls returned one/zero; reply-to-gate durability remains owned by the crash test; Slice 9 runs it against `src`. |

`sf-spec-authoring` inventory found no existing analyzer overlap. It returned `REJECT` for custom analyzers covering exactly-once replay, explicit unknown outcomes, hash-chain/artifact integrity, exclusive locking, cumulative budgets, consent identity/freshness, whole-workspace evidence, crash recovery, and provider decoding: these are runtime, durable-state, protocol, or operating-system behaviors, and a structural source pattern would be weak evidence. The named behavioral, fault-injection, real-process, and qualification checks in `## Test plan` own them.

Each analyzer produced one expected high finding in the shared durable unsafe root and zero findings with non-vacuous guard/operation matches in the shared durable safe root under complete TypeScript control-flow analysis. Product-root verdicts are currently `UNKNOWN` because `src` does not exist; Gate 4 witnesses must scan exactly `src`, require the retained unsafe control to keep firing, require the safe control to remain zero, and require implemented source to return zero findings under non-vacuous complete analysis. Scanning the repository root is invalid because it intentionally contains the unsafe control.

## Threat model
Independent Gate 3 Red Team initial verdict: `NEEDS REVISION`; final targeted rechecks: `SOUND`. The six original findings and two recheck findings are incorporated: durable `run.created` precedes the startup handshake; recovery verifies history and identity before group probes or generation changes; provider preflight builds only a pure invocation and execution uses the single authorization path; the final group-absence check shares the function guarded before commit; reply decision, approval-gate outcome, and callback effect are distinct durable boundaries; the native-host spike is a durable multi-process conversation before engine construction; and the detached supervisor itself acquires and retains the workspace lock before authoritative writes. The reopened-Gate recheck also confirmed the two consolidated controls are durable, outside `src`, and cover all nine retained analyzers without changing the threat model.

Threat-model verdict: `MODELED`. Evidence tiers are: Tier A — normative `SPEC.md` plus approved Product and Architecture gates; Tier B — planned files, interfaces, call stacks, and tests in this document; Tier C — analyzer YAML plus unsafe/safe controls, which are planning evidence rather than product proof.

Scope: user, Codex/Claude parent host, CLI/host clients, supervisor, trusted flow worker, runner/guardian, native provider binaries, operating system/filesystem, and external systems affected by commands/providers. In scope are local run creation, compilation, IPC, journal/artifacts, process authorization/cleanup, replay/recovery, workspace evidence, human decisions, provider authentication/permissions, limits, lifecycle CLI, wrappers, and qualification.

Entry points: `flow()` and context primitives; bundled imports/instruction paths/prompts/contracts/artifact references; host functions and lifecycle CLI inputs; cancellation and wrappers; worker/supervisor and runner/supervisor IPC; inbox reply/recovery envelopes; workspace paths/symlinks/executable resolution; journal/artifact/manifest/view/backup reads; provider status, environment/config selectors, terminal output files/streams, and exit/signal facts.

Trust boundaries: person/native host to reply envelope to supervisor; unknown CLI/host input to contracts and lifecycle state; trusted worker IPC to authoritative supervisor; supervisor authorization to inert runner to target process group; native command/provider output to bounded artifacts/decoder/worker contract; mutable workspace/executable/configuration to evidence used for decision/dispatch/replay/success; in-memory execution to synchronized journal/artifacts to post-crash recovery; and private evidence to diagnostics, wrappers, retention, or explicit support export.

Assets: authoritative journal and immutable evidence; external-effect count and unknown-effect truth; human decision identity/freshness/scope; pinned flow/input/dependency/executable/provider identity; workspace contents and accepted baselines; lock/generation/runner/process identities; cumulative calls/commands/time/storage/deadlines; native subscription route and permissions; and private prompts/source/output/artifacts.

| ID | Property | Concrete mechanism | Asset | Planned location/path | Severity | Mitigation | Observable verification property | Design evidence |
|---|---|---|---|---|---|---|---|---|
| T1 | Validate before state/control use | Malformed, oversized, unknown-version, traversal, symlink, forged artifact reference, or provider payload reaches allocation, state mutation, or execution. | Journal, workspace, process authority, availability | `src/contracts.ts`, `src/prompts.ts`, `src/workspace.ts`, `src/cli.ts`, `src/adapters/*.ts`; contract/workspace tests | High | Bounded discriminated decoding, canonical JSON, containment/hash/size/version checks, receiver-side validation. | Invalid, unknown, escaping, corrupt, or oversized input commits no success and starts no effect; bounds apply before allocation. | SPEC §§3.1,5,8,13–16 (A); planned files/calls/tests (B); validation analyzer (C). |
| T2 | One durable authority and intact evidence | Concurrent supervisors, torn append, forged view, missing artifact, stale backup, or partial publication creates split-brain or false completion. | Journal, artifacts, receipts, result, ownership | `src/ownership.ts`, `src/journal.ts`, `src/artifacts.ts`, `.coding-flow/owner.lock`, run store; storage/ownership tests | Critical | Stable lock, sole journal authority, artifact sync/rename before event, hash chain, verified recovery, derived views. | Two claimants never append concurrently; only incomplete trailing fragments are repairable; corrupt history or missing committed evidence never executes or succeeds. | SPEC §§6–7,16 (A); planned modules/call stacks/tests (B); artifact analyzer (C). |
| T3 | Authorization dominates execution; cleanup dominates commit | Target starts before durable one-use authorization, duplicate execute launches twice, or stale group identity is signalled/committed as absent. | Effect count, unrelated processes, ownership | `src/process.ts`, `src/runner.ts`, `src/ownership.ts`, `src/supervisor.ts`; ownership/crash tests | Critical | Inert registered runner, generation/nonce authorization, live private channel, final absence check, conservative recovery probe. | Before authorization target count is zero; duplicate authorization launches at most once; recovery never signals a reused group; outcome commits only after proven absence. | SPEC §§6.1–6.2,7.3,18.2 (A); corrected calls/tests (B); authorization/cleanup analyzers (C). |
| T4 | Committed replay without redispatch; uncertainty remains explicit | Crash after authorization/effect but before commit triggers retry, fabricated outcome, history skipping, or budget refund. | Effect count, history truth, budgets | `src/supervisor.ts`, `src/replay.ts`, `src/recovery.ts`; execution/recovery/crash tests | Critical | Five-stage attempt protocol, exact trace matching, committed replay, evidence-eligible reconciliation, linked replacements. | Every crash point yields no dispatch, zero-redispatch replay, or `OUTCOME_UNKNOWN`; retry requires an eligible explicit decision and new reservation. | SPEC §§7.3,9–12,18.2 (A); corrected calls/tests (B). |
| T5 | Authentic, fresh, single-use consent | Same-user forged, stale, conflicting, duplicate, expired, or scope-drifting reply opens an unauthorized effect. | Human authority, workspace, external systems | `src/human.ts`, `src/recovery.ts`, `src/host.ts`, `src/cli.ts`, run inbox; human/crash tests | Critical | Exact request identity, historical dedup first, first valid decision, freshness/watch checks, durable gate outcome, one-effect callback, new recovery consent. | Rejection, expiry, staleness, conflict, duplicate, or second callback effect adds zero unauthorized dispatches; one current opened gate permits at most one effect. | SPEC §§11–12 (A); corrected reply/gate/effect flow (B); narrowed approval analyzer (C). |
| T6 | Pinned identity and race-resistant evidence | Flow, dependency, instruction, executable, model, workspace, or watched file changes between observation, consent, dispatch, replay, or success. | Deterministic replay, consent relevance, result validity | `src/build.ts`, `src/workspace.ts`, `src/replay.ts`, `src/prompts.ts`; workspace/replay tests | High | Pinned bundle/versions, canonical executable identity, whole-workspace manifests, immutable snapshots, checks before effect/decision/success. | Any unaccepted mutation blocks before new effect/success or creates a new decision revision; committed self-edits replay only against their post-baseline. | SPEC §§5,8.1,10–11 (A); planned calls/tests (B); freshness analyzer (C). |
| T7 | Native authentication and permission non-bypass | Selector routes to API billing/alternate provider; malformed result is accepted; model or write access differs from qualified execution. | Subscription/account, permissions, result truth, private configuration | `src/adapters/*.ts`, `src/process.ts`, adapter/qualification tests, `compatibility.json` | High | Exact qualification, recognized subscription status, conflicting-selector rejection, no fallback, explicit model, native restrictions, strict terminal decoder. | Unsupported/ambiguous configuration blocks before dispatch; no credential leak; malformed/conflicting/missing result cannot succeed; model mismatch reports partial-effect risk. | SPEC §§14,16,19 (A); planned adapter/spike/tests (B); revalidated preflight analyzer if retained (C). |
| T8 | Bounded execution and local confidentiality | Huge input/output/history/workspace/mailbox, repeated crashes, clock rollback, or diagnostics/export exhausts or discloses resources. | Availability, budgets, private source/prompts/output | supervisor/artifact/journal/process/contracts/CLI modules; storage/contract/crash/qualification tests | High | Streaming caps, reservation, serial effects, persisted grants/wall watermark, owner-only storage, bounded sanitized diagnostics, no telemetry, explicit export only. | Bounds hold before authorization/allocation; restart never refunds work; clock rollback blocks decisions; logs contain no tokens, account identifiers, credentials, or automatic export. | SPEC §§7.4,9.1,13,16,18–19 (A); planned modules/tests (B). |

Decisions: keep one local package, one supervisor journal authority, one shared process manager, one durable receipt path, and serial effects; trust flow code and the native host relay while validating their messages; preserve native provider auth/model/permissions with no fallback; use whole-workspace and pinned-executable evidence; keep authorized-but-uncommitted effects unknown; accept that mailbox possession is not cryptographic human proof; and qualify exact runtime/provider/OS/filesystem combinations before support.

Limitations: no implementation exists, so there is no source-derived call graph, taint, permission audit, or runtime proof. Analyzer controls prove only their prepared examples until product calls exist. Same-user tampering, forged local human origin, deliberate process-group escape, provider internals, remote rollback, cross-machine recovery, native Windows, network/cloud-synced filesystems, storage rollback, and broken synchronization hardware remain outside the guarantee. Native nesting, addon installation, locking/durability, cleanup/reboot, and provider routing remain unqualified. The later Security review derives scope independently from implemented source. Omitted threat count: 0.

## Least confident decisions
1. Real nested Codex and Claude execution may be blocked by host policy even when the standalone CLIs work; the native-host feasibility slice must fail cheaply before engine construction.
2. `fs-ext`, directory/file synchronization, append recovery, and process-group behavior may differ across intended operating systems and filesystems; the foundation slice must qualify each exact combination before upper layers rely on it.
3. A compact set of internal test seams for clock, store, process service, workspace evidence, and ownership must enable fault injection without becoming a parallel in-memory architecture; tests should exercise public behavior and real storage/processes wherever the guarantee depends on the OS.
4. Whole-workspace hashing is the simplest correct freshness model but may dominate latency on large repositories; keep the fixed bounds and instrument scan time before considering verified immutable-cache reuse.
5. Local mailbox possession cannot cryptographically prove human origin; v2 deliberately trusts the native host relay and must state that limitation wherever approval authority is described.
