# EXECUTION.md — Commit-by-Commit Build Plan

This is the working document used while building. It slices every task in `architecture-plan-codebase-assistant.md` into atomic commits, grouped by Day and Phase, with security review checkpoints between batches.

## Rules of execution

1. **One concern per commit.** No mixing scaffold + feature + tests across files unrelated to one purpose.
2. **Every commit compiles and tests pass.** Never push a commit that breaks `main`.
3. **Tests ship with their feature.** A `feat:` commit includes the unit tests for that feature in the same commit. Separate `test:` commits only for adding test infrastructure or back-filling missing coverage.
4. **Conventional commits.** `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `ci:`, `style:`, `refactor:` — with a scope where useful, e.g. `feat(server):`, `feat(frontend):`.
5. **Security review after each batch.** A "batch" = end of a Day or end of a Phase. Process documented below.
6. **No force-pushes to main.** Mistakes get a follow-up commit, not a rewrite.

---

## Pre-flight (one-time, before commit #1)

```
[ ] Confirm gh CLI is authenticated:           gh auth status
[ ] Create the public repo:                    gh repo create advanced-troubleshooter --public --description "Codebase-aware support assistant"
[ ] Clone it locally:                          gh repo clone advanced-troubleshooter
[ ] Move both .md files into the new repo:     architecture-plan + EXECUTION.md
[ ] Verify git author identity is correct:     git config user.name && git config user.email
```

---

## Security review process (between batches)

After each batch (end of Day or end of Phase), spawn a security-review subagent with this prompt template:

```
Review the diff between commits {start_sha} and {end_sha} in this repo.

Check for:
1. Secrets or credentials committed in plaintext (any string matching ghp_, github_pat_,
   sk-, or anything that looks like an API key)
2. Missing input validation on routes (every route should validate via the shared
   api-contracts Zod schemas)
3. Authentication or authorization bypasses (every protected route must run through
   auth middleware; tenant scoping must be enforced)
4. Injection vectors (SQL, command, prompt injection — verify LLM providers use
   their dedicated system-prompt mechanisms)
5. Insecure dependencies introduced (check package.json additions for known CVEs)
6. Secrets logged or returned in error messages (check logger calls, error responses,
   and Sentry payloads)
7. Cross-tenant data access risks (any DB query that doesn't filter by tenant_id)
8. CORS misconfiguration (overly permissive origins outside dev mode)
9. Rate limiting bypasses (any endpoint reachable without going through the limiter)
10. Token storage practices (API keys must be hashed, never stored or logged in plaintext)

Report findings as: [SEVERITY] [FILE:LINE] [DESCRIPTION] [RECOMMENDED FIX]
Severity: CRITICAL / HIGH / MEDIUM / LOW / INFO

If no issues, say so explicitly. Do not invent issues to look thorough.
```

The reviewer agent is invoked via the Agent tool with subagent_type=general-purpose. Findings are addressed in fix-up commits before proceeding to the next batch.

---

## Phase 1: Backend + Chat (Commits 1–26)

### Day 1 — Project setup + operational foundations

```
1.  chore: initialize monorepo skeleton
    - root package.json with npm workspaces
    - .gitignore (node_modules, dist, .env, .env.local, .DS_Store)
    - README.md (one-paragraph project description + pointer to docs/)
    - LICENSE (MIT)
    - .claude/agents/security-reviewer.md (the prompt template above, made reusable)

2.  chore(server): scaffold Fastify server with no routes
    - packages/server/package.json (deps: fastify, pino)
    - packages/server/tsconfig.json
    - packages/server/src/index.ts (server boots, listens, no routes yet)
    - packages/server/.env.example (APP_MODE, PORT, LOG_LEVEL, DATABASE_URL stubs)

3.  chore(shared): scaffold shared package with api-contracts stub
    - packages/shared/package.json
    - packages/shared/src/api-contracts.ts (empty, Zod imported, populated as routes are added)

4.  feat(server): add structured logging + error tracker stub
    - infrastructure/logger.ts (Pino, JSON output, request_id/tenant_id/session_id fields)
    - infrastructure/errorTracker.ts (Sentry init, no-op if SENTRY_DSN unset)
    - logger.test.ts (verifies fields are present in output)

5.  feat(server): add APP_MODE config + domain errors module
    - config/appMode.ts (typed enum, throws if APP_MODE is not "prototype" | "production")
    - shared/errors/domainErrors.ts (NotFoundError, ValidationError, ForbiddenError,
      ConflictError, RateLimitError)
    - appMode.test.ts (each mode parses correctly, invalid value throws)

6.  feat(db): add initial schema + migration runner + local Postgres
    - db/migrations/001_init.sql (conversations, analytics_events, api_keys)
    - scripts/migrate.ts (applies all .sql files in order, idempotent)
    - docker-compose.yml (Postgres on port 5433, persistent volume)
    - npm script "migrate" wired in
    - migrate.test.ts (runs against fresh DB, asserts tables exist)

7.  feat(server): add tenant config loader with secret-scan
    - config/tenants.ts (loads JSON files, resolves ${ENV_VAR}, throws on raw GH tokens)
    - tenants/_template.json (annotated with field descriptions)
    - tenants/team-alpha.json (your test repo, ai.provider stub)
    - tenants.test.ts (env var resolution, missing fields throw, raw token throws)

8.  feat(server): wire middleware chain
    - middleware/cors.ts (reads APP_MODE; permissive in prototype, per-tenant in production)
    - middleware/auth.ts (validates Authorization header; APP_MODE=prototype uses single .env key)
    - middleware/tenantResolver.ts (attaches frozen req.tenant)
    - middleware/rateLimiter.ts (in-memory store; reads APP_MODE for limits)
    - middleware/errorHandler.ts (catches domain errors, maps to HTTP)
    - tests for each middleware (auth bypasses, tenant 404, rate limit triggers, error mapping)

9.  feat(server): implement health route
    - routes/health.ts (returns { status, version, appMode, checks: { database } })
    - routes/health/deep variant (also pings external services on demand)
    - health.test.ts (returns ok when DB reachable, returns degraded when DB down)

10. ci: add GitHub Actions workflows
    - .github/workflows/ci.yml (lint, typecheck, unit + integration tests)
    - .github/workflows/secret-scan.yml (gitleaks against tenants/*.json)
    - both run on PR and push to main

11. chore: first Render deployment (free tier)
    - render.yaml blueprint (web service + env var declarations)
    - docs/deploy-render.md playbook covering Supabase Postgres + Render setup
    - deploy /api/v1/health, verify it returns appMode: "prototype" and database: "ok"
```

**End of Day 1 — Security review batch #1**

### Day 2 — Infrastructure + repository layers

```
12. feat(infra): add Supabase client singleton
    - infrastructure/supabaseClient.ts
    - supabaseClient.test.ts (singleton behaviour)

13. feat(infra): add GitHub MCP client
    - infrastructure/githubMcp.ts (search files, read file contents — read-only)
    - githubMcp.test.ts (mocked HTTP, verifies correct endpoints called)

14. feat(infra/llm): add LlmProvider interface and shared types
    - infrastructure/llm/types.ts (LlmProvider interface, Message, TokenUsage)
    - types.test.ts (interface contract is what we expect)

15. feat(infra/llm): implement Claude provider
    - infrastructure/llm/claudeProvider.ts (uses Anthropic SDK; system parameter)
    - claudeProvider.test.ts (system prompt routing, spend cap enforcement)

16. feat(infra/llm): implement OpenAI provider
    - infrastructure/llm/openaiProvider.ts (uses OpenAI SDK; system role first message)
    - openaiProvider.test.ts (system message routing, spend cap enforcement)

17. feat(infra/llm): implement Gemini provider
    - infrastructure/llm/geminiProvider.ts (uses Google AI SDK; systemInstruction)
    - geminiProvider.test.ts (systemInstruction routing, spend cap enforcement)

18. feat(infra/llm): add provider factory
    - infrastructure/llm/llmFactory.ts (returns provider based on tenant.ai.provider)
    - llmFactory.test.ts (returns correct provider for each value, throws on unknown)

19. feat(repo): add conversation repository
    - repositories/conversation.repository.ts (getHistory, saveMessage)
    - conversation.repository.test.ts (mocked Supabase: tenant_id always present, soft-delete excluded)
    - conversation.repository.integration.test.ts (real local Postgres)

20. feat(repo): add analytics repository
    - repositories/analytics.repository.ts (logEvent — provider name in metadata)
    - analytics.repository.test.ts

21. feat(repo): add API key repository
    - repositories/apiKey.repository.ts (storeKeyHash, findByKeyHash, never plaintext)
    - apiKey.repository.test.ts
```

**End of Day 2 — Security review batch #2**

### Day 3 — Service + route layers

```
22. feat(service): add AI service
    - services/aiService.ts (orchestrates: history → MCP → llmFactory → save → log)
    - aiService.test.ts (call order, error propagation, tenant systemPrompt used)

23. feat(service): add prompt injection test suite (parametrized × 3 providers)
    - services/promptInjection.test.ts (10 injection cases × Claude/OpenAI/Gemini)

24. feat(service): add API key service + admin script
    - services/apiKeyService.ts (generate, hash, verify roundtrip)
    - scripts/createApiKey.ts (CLI; prints plaintext once, stores hash)
    - apiKeyService.test.ts (hash/verify roundtrip, never returns plaintext from store)

25. feat(shared): populate api-contracts with /chat schema
    - packages/shared/src/api-contracts.ts (ChatRequest, ChatResponse Zod schemas)
    - api-contracts.test.ts (valid input passes, invalid shapes rejected)

26. feat(routes): implement POST /api/v1/chat
    - routes/chat.ts (validates via api-contracts, calls aiService, lets errors bubble)
    - chat.route.test.ts (auth required, tenant resolution, validation rejection)
    - manual curl test against deployed Railway URL succeeds with real repo question
```

**End of Phase 1 — Security review batch #3 + Phase 1 milestone check**

Milestone: `curl` Railway URL → ask question about your repo → get a code-grounded answer.

---

## Phase 2: Frontend Chat UI (Commits 27–36)

### Day 4 — Both entry points built simultaneously

```
27. chore(frontend): scaffold Vite + React + TypeScript
    - packages/frontend/package.json (vite, react, typescript)
    - packages/frontend/tsconfig.json, vite.config.ts (single target initially)
    - packages/frontend/.env.example (VITE_API_URL, VITE_TENANT_ID, VITE_API_KEY)

28. feat(frontend): add config module that supports both modes
    - src/config.ts (reads import.meta.env in app mode, custom element attrs in widget mode)
    - config.test.ts (both code paths return the right values)

29. feat(frontend): add API client + session/chat hooks
    - src/services/apiClient.ts (uses contracts from packages/shared)
    - src/hooks/useSession.ts (UUID, persists in localStorage)
    - src/hooks/useChat.ts (message state, calls apiClient)
    - tests for each (mocked fetch, hook behavior verified)

30. feat(frontend): build core components
    - components/ChatWindow.tsx, MessageBubble.tsx, InputBar.tsx, CodeSnippet.tsx
    - CSS as CSS Modules — no global selectors, no body styles
    - components.test.tsx (renders, accepts props, no document.body access)

31. feat(frontend): add main.tsx entry point (prototype)
    - src/main.tsx (renders ChatWindow into <div id="root">)
    - index.html
    - npm run dev works against deployed Railway backend

32. feat(frontend): add widget.tsx entry point (production)
    - src/widget.tsx (defines <codebase-assistant> custom element)
    - mounts ChatWindow into Shadow DOM
    - reads api-url, tenant-id, api-key from HTML attributes
    - widget.test.ts (registers, attributes parsed, Shadow DOM isolated)

33. feat(frontend): configure dual build targets
    - vite.config.ts updated with conditional logic for app vs lib mode
    - npm scripts: build:app (SPA) + build:widget (single JS file with inlined CSS)
    - manual verification: drop widget JS into a plain HTML page, confirm it works
```

**End of Day 4 — Security review batch #4**

### Day 5 — Polish and verification

```
34. feat(frontend): add loading + error states
    - typing indicator while LLM thinks
    - error toast on network failure or rate limit
    - tests for loading state, error rendering

35. style(frontend): clean baseline styling
    - dark sidebar theme; minimal but professional
    - no global selectors that would leak from Shadow DOM

36. chore(frontend): deploy to Vercel + verify both modes
    - vercel.json or framework auto-detection
    - manual end-to-end test in both full-page and embed modes
    - share Vercel URL with one teammate, capture feedback
```

**End of Phase 2 — Security review batch #5 + Phase 2 milestone check**

Milestone: Vercel URL works in browser. Embed JS works in plain HTML. Conversations land in Supabase.

---

## Phase 3: Issue Drafting (Commits 37–42)

### Day 6 — Issue draft backend

```
37. feat(service): add issue formatter
    - services/issueFormatter.ts (uses LlmProvider to fill template fields)
    - issueFormatter.test.ts (handles partial output, all fields filled)

38. feat(infra): add issue creator
    - infrastructure/issueCreator.ts (GitHub Issues API write, uses issue-write token)
    - issueCreator.test.ts (correct endpoint, correct auth header, error on 4xx)

39. feat(service): add issue service with draft token signing
    - services/issueService.ts (orchestrate: format → MCP → sign draft token → create on demand)
    - issueService.test.ts (draft does not call issueCreator, /create rejects expired/wrong-tenant tokens)

40. feat(routes): add issue draft + create endpoints
    - shared/api-contracts.ts gains IssueDraftRequest/Response, IssueCreateRequest/Response
    - routes/issues.ts (draft + create)
    - issues.route.test.ts (auth, contract validation, tenant scoping, draft token verification)
```

### Day 7 — Issue draft frontend

```
41. feat(frontend): add mode toggle + issue draft hook
    - components/ModeToggle.tsx (Ask Question ↔ Draft Issue)
    - hooks/useIssueDraft.ts (form state, calls apiClient)
    - tests for both

42. feat(frontend): build IssueDraftPreview + Create flow
    - components/IssueDraftPreview.tsx (editable preview of filled template)
    - "Create Issue" button → calls /create → shows resulting GitHub issue URL
    - IssueDraftPreview.test.tsx
```

**End of Phase 3 — Security review batch #6 + Phase 3 milestone check**

Milestone: Agent describes a problem → tool drafts a structured issue → agent reviews → clicks Create → issue appears in GitHub.

---

## Phase 4: Multi-Tenant + Production Switch (Commits 43–49)

```
43. feat(tenants): add second tenant config with a different LLM provider
    - tenants/team-beta.json (different repo, different provider — e.g. Claude vs OpenAI)
    - .env.example updated with second tenant's keys

44. test(server): add tenant isolation suite
    - tests/tenantIsolation.test.ts (cross-tenant access attempts → all rejected)
    - covers: body-spoofed tenantId, sessionId from other tenant, draft token cross-use,
      direct DB assertion that all rows have correct tenant_id

45. test(e2e): add Playwright suite
    - packages/e2e/chat.spec.ts
    - packages/e2e/issueDraft.spec.ts
    - packages/e2e/issueCreate.spec.ts
    - packages/e2e/auth.spec.ts
    - packages/e2e/embed.spec.ts (drops widget JS into HTML, runs full chat flow)
    - CI job that runs Playwright against staging URL

46. feat(frontend): add feedback (thumbs up/down)
    - feedback buttons on each assistant message
    - apiClient.recordFeedback() → backend logs to analytics_events

47. docs: write onboarding.md
    - 5-step team self-service guide (create token → fill template → set env var → PR → embed)

48. docs: write production-deploy.md
    - 8-step prototype → production switch (APP_MODE flip, API keys, CORS, Sentry, etc.)

49. chore: flip APP_MODE=production in Railway
    - verify health check confirms production mode
    - verify per-tenant CORS enforced
    - verify per-tenant rate limits enforced
    - run full Playwright suite against the production-mode deployment
```

**End of Phase 4 — Security review batch #7 (final)**

Milestone: Two isolated tenants on different LLM providers. Production mode active. Onboarding and deploy docs ready. AM teams can self-serve.

---

## Total commit count

| Phase | Commits | Security reviews |
|---|---|---|
| Phase 1 | 26 | 3 (end of Day 1, Day 2, Phase 1) |
| Phase 2 | 10 | 2 (end of Day 4, Phase 2) |
| Phase 3 | 6 | 1 (end of Phase 3) |
| Phase 4 | 7 | 1 (end of Phase 4) |
| **Total** | **49** | **7** |

---

## What "build complete" means

- All 49 commits land on `main`
- All 7 security reviews pass with no CRITICAL or HIGH findings outstanding
- CI is green
- Health check on production deployment returns `appMode: "production"`
- E2E suite passes against the production deployment
- Two tenants operational on different LLM providers
- An AM team-mate, given only the URL of `docs/onboarding.md`, can add a third tenant without contacting you

That is the bar.
