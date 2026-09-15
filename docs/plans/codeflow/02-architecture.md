# Architecture: Codeflow
## Fit
Codeflow enters the currently specification-only repository as one local Node.js package. Its public interface is deliberately small: an author interface for declaring and running flows, a host interface for starting/resuming/responding, a testing interface, and one lifecycle CLI. Behind those interfaces, deep modules concentrate compilation, durable execution, process ownership, replay, workspace evidence, human decisions, and provider-specific translation.

The supervisor is the sole journal and commit authority. A guarded worker executes trusted flow code and validates the original contracts, while a shared process runner owns each external process group and captures raw evidence. Runners may write only unique, bounded attempt evidence, and clients may write only atomic inbox envelopes; neither is authoritative until the supervisor validates and references those bytes in a committed event. Codex and Claude are adapters at one provider seam; they translate requests and results but never own authoritative storage, process lifecycle, or control flow.

Repository analysis: reused the fresh `docs/codebase-overview.md` onboarding instead of dispatching another repository worker because the tracked repository still has no implementation to inspect.
## Endpoints
None. Codeflow is a local package and command-line tool; it exposes no network service or webhook.
## Data
No database. Each workspace contains one stable ownership lock and a `.coding-flow/` run store. Every logical run has an immutable manifest, pinned flow bundle and source identity, append-only hash-linked event journal, immutable artifacts, operation-attempt evidence, reply inbox, and rebuildable status/receipt/result views.

The event journal is authoritative; views never override it. Artifacts are made durable before an event may reference them. A primitive progresses through `prepared → registered → authorized → returned → committed`; only a committed outcome may reach flow code. Workspace manifests and hashes tie execution, human evidence, and recovery to the exact observed files.
## Flow
1. A host wrapper or CLI request resolves an exact qualified runtime, acquires the stable workspace lock, creates a durable logical run, and starts a run-scoped supervisor.
2. The supervisor launches a guarded worker. The worker compiles and validates the pinned flow, input, policies, and initial workspace evidence before author code can cause an effect.
3. For each command or provider task, the worker describes one boundary to the supervisor. The supervisor authenticates, checks limits and workspace freshness, reserves capacity, and durably prepares the attempt.
4. The supervisor starts an inert process runner, durably registers it, durably authorizes exactly one execution, then lets it start the target process group.
5. The runner streams bounded raw evidence and returns actual exit or signal facts. After the process group is absent, the supervisor captures the post-operation workspace state and gives the candidate result to the worker for original contract validation.
6. The supervisor durably commits the accepted result or error before acknowledging it to flow code. Later replay returns that committed outcome with zero external redispatch.
7. For a question or approval, the supervisor first commits the immutable presentation and request. The host displays the exact evidence, gathers the person's real answer, and submits a reply bound to the run, request, revision, presentation, and canonical answer. The supervisor validates and commits that decision before continuation; duplicates return the historical receipt. The host preserves native origin metadata when available, but local possession is not cryptographic proof of human origin. Approved callbacks can authorize at most one external operation.
8. After interruption, a new supervisor verifies ownership, versions, history, artifacts, old process groups, limits, and workspace evidence; reconstructs the worker from the pinned bundle; and replays committed boundaries until the live frontier. Unresolved authorized effects enter explicit evidence-backed recovery rather than automatic retry.
9. Success is published only after final output validation, complete history consumption, no pending work, clean process ownership, current workspace evidence, durable artifact publication, and a committed terminal event.
## Constraints
- Linux, macOS, and WSL2 on qualified local filesystems only; WSL workspaces live on the Linux filesystem.
- One unresolved logical run reserves a workspace; external operations are serial.
- Trusted flow code only. Codeflow controls its managed processes but is not a sandbox for hostile same-user code.
- Exact engine, runtime, dependency, provider, operating-system, and filesystem combinations must be qualified and pinned; mismatches block before new work.
- Native provider permissions and subscription authentication remain authoritative. No credential extraction, API-key fallback, provider SDK fallback, restriction bypass, or automatic account/model change.
- Durable ordering is non-negotiable: artifact before event, authorization before execution, commit before delivery, and fresh evidence before a decision or new effect.
- Bounds apply to time, calls, commands, storage, journal size, workspace size, messages, output, prompts, and attachments; interruption cannot reset them.
- Every receiver validates bounded discriminated input, artifact containment, path/hash/size facts, protocol version, and freshness before using it for state or control flow.
- Before dependent recovery, consent, or provider work, each intended operating-system/filesystem class must prove native-addon installation, stable locking, sync/rename/append durability, process-group cleanup, parent-loss behavior, and reused-process-ID-safe absence checks. Native-host feasibility also proves subscription routing, nested execution, structured results, edits, and human round-trips. A failed foundation or blocked nested launch makes that combination unsupported, not bypassed.
- `sf-red-team`: triggered because native-host nesting, filesystem durability, process cleanup, human consent, and unknown external effects are consequential architecture risks.
## External
- Official installed `codex` and unmodified `claude` CLIs, using their normal subscription login and native permission mechanisms.
- Node.js 24 LTS as runtime; TypeScript for authored flows and the package.
- Zod for runtime contracts, esbuild for pinned flow bundles, and `fs-ext` only for the kernel-backed workspace lock.
- Local POSIX process groups and qualified filesystem synchronization semantics.
- No hosted service, database, provider API SDK, credential broker, telemetry service, or user-facing bypass flag.

## Red Team
Independent verdict: `NEEDS REVISION`; all three findings are incorporated above. The supervisor is now the sole authoritative writer rather than the only durable writer; receiver-side validation and the same-user human-origin limit are explicit; and platform storage/process foundations move ahead of their consumers. A second pass was not triggered because these were direct corrections with no unresolved architecture choice.

Threat model: `MODELED`. Retained properties and their required observable checks:

| ID | Threat property | Architecture mitigation | Required verification property |
|---|---|---|---|
| T1 | Authentic, fresh consent | Immutable evidence, exact reply identity, first valid decision, freshness recheck, commit before continuation | Rejected, expired, stale, conflicting, or duplicate replies dispatch zero additional approved effects; only the current exact affirmative decision opens one operation. |
| T2 | Validated deserialization and containment | Bounded discriminated inputs, validated unknown data, canonical encoding, containment/hash/size checks, strict path and symlink policy | Invalid, unknown, escaping, corrupt, or oversized input commits no success and starts no effect. |
| T3 | Authorization before execution; commit before delivery | Inert registered runner, one-use generation/nonce authorization, durable committed outcomes, explicit unresolved recovery | Each crash point produces zero dispatch, one replayed committed result with zero redispatch, or an explicit unknown block. |
| T4 | Exclusive ownership and process isolation | Stable kernel lock, ownership generation, registered groups, live-channel cancellation, conservative absence proof | Two claimants never append concurrently; recovery never signals a stale numeric group; new work waits for proven group absence. |
| T5 | Native permission and authentication non-bypass | Exact qualified binaries/configuration, recognized subscription route, conflicting-selector rejection, no fallback | Ambiguous or unsupported authentication/configuration blocks before dispatch and leaks no credential/account values. |
| T6 | Evidence freshness and race resistance | Whole-workspace hashes, immutable snapshots, checks before decision/effect/success, post-operation baselines | Any unaccepted mutation blocks or creates a new decision revision before dispatch. |
| T7 | Bounded attacker-controlled complexity | Fixed byte/count/time/storage limits, streaming, capacity reservation, serial effects, persisted counters | Bounds apply before unbounded allocation or authorization; restart never refunds charged work. |
| T8 | Local confidentiality and evidence integrity | Owner-only storage, restrictive creation mode, immutable publication, verified references, no telemetry/credential logging | Corrupt history cannot execute; committed artifacts match identity and size; diagnostics contain no secrets. |

Accepted boundaries: flow code and the relaying host are trusted; hostile same-user control, provider internals, escaped daemons, storage hardware violating synchronization, and remote rollback are outside the guarantee. These limits must remain visible rather than being converted into success claims.
