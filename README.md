# codeflow
A TypeScript workflow engine for Codex and Claude Code. Write readable flows with inline prompts, typed results, human approvals, and resumable execution using your existing subscriptions.
Write coding-agent workflows as ordinary TypeScript. Use code for branches, loops, and checks, and call an agent when the task needs reasoning.

Codeflow runs the same flow through Codex or Claude Code using your existing subscription, without API keys. It validates structured results, presents evidence before human decisions, and preserves progress so interrupted work can resume without repeating completed operations.
Invoke an entire flow as a skill, while keeping its procedure in one readable TypeScript file.
