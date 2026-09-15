# Product: Codeflow
## Problem
Developers can ask coding assistants to perform useful multi-step work, but today the procedure, evidence, approvals, and recovery are too easy to lose when a session, worker, or machine is interrupted. That makes long-running work hard to trust: a completed action may be repeated, an uncertain action may be mistaken for failure, or a human decision may be reused after its evidence has changed.
## Success metric
Before the first production-ready release, 100% of the required acceptance scenarios complete successfully in both supported coding assistants, measured by the checked release-qualification run. The scenarios must include interruption and recovery, evidence-backed human decisions, bounded cancellation, and proof that completed external actions are not repeated.
## Non-goals
- Running untrusted user code in a security sandbox.
- Supporting native Windows, shared or cloud-synchronized workspaces, or recovery on another machine.
- Running multiple external actions in parallel.
- Automatically undoing external actions.
- Migrating old execution histories between incompatible releases.
- Replacing the coding assistants' own permissions, login, or billing routes.
## Announcement — the blog post before the feature
Codeflow lets developers express reliable coding procedures while continuing to use their existing coding assistants and subscriptions. Every meaningful result is checked before the procedure relies on it, and every human decision is tied to the evidence that was actually shown. If work is interrupted, Codeflow resumes from durable history instead of silently repeating completed actions or guessing what happened. Clear limits, cancellation, and explicit uncertainty make long-running automation safer to trust.
## Screens
No UI.
