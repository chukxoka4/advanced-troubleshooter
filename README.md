# advanced-troubleshooter

A codebase-aware support assistant for product support teams. Agents ask questions in plain English; the assistant answers grounded in the live source of the product — with exact file paths and line ranges — and, when a genuine bug or feature request surfaces, drafts a structured GitHub issue the agent can review and file in one click.

## How it works

Each tenant's repos are indexed into a lightweight **repo map** (function and class signatures with line ranges, produced by `tree-sitter`). On every question the map is injected into the model's system prompt, and the model navigates the code through a small set of tools — `readFile`, `searchCode`, `findSymbol`, `createIssue`, `searchIssues` — in an agent loop. There is no vector DB and no expensive re-indexing pipeline: the map refreshes on commit, and the model reads exact lines from GitHub on demand.

## Per-repo scoping (no cross-repo leakage)

A tenant may own many repos, but a single question only ever runs against the repos the agent selects at query time. The repo-scope gate is enforced at three layers — request validation, the agent loop's tool dispatcher, and each tool's own execution — so the model cannot read a repo the user deselected, and one tenant can never see another tenant's code.

## Provider-agnostic

Tool calling is implemented behind a common `LlmProvider` interface. Each tenant picks its own provider (OpenAI, Claude, or Gemini) and its own API key in config. No service file imports a vendor SDK directly.

## Documentation

- [`architecture-plan-codebase-assistant.md`](./architecture-plan-codebase-assistant.md) — full design, layers, data flow, isolation model
- [`EXECUTION.md`](./EXECUTION.md) — commit-by-commit build plan
- `docs/` — onboarding, local dev, production deploy (written during Phase 4)
