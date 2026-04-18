# EXECUTION.md — Commit-by-Commit Build Plan

This is the working document used while building. It slices every task in `architecture-plan-codebase-assistant.md` into atomic commits, grouped by Day and Phase, with security review checkpoints between batches.

> **Status (after Phase 1):** Commits 1–26 shipped. The live deployment on Render + Supabase passed the end-of-Phase-1 security review but the retrieval pipeline (GitHub `/search/code` keyword search) proved insufficient for natural-language support questions — it returns zero context for any question whose answer is not a literal keyword match, and is subject to GitHub's private indexing lag on new repos. Phase 2 onward (commits 27+ in this document) replaces that retrieval layer with a **repo map + agent loop**, adds **per-repo scoping** at query time, and folds issue creation into the agent loop as a tool call. The layered architecture, tenant isolation, provider-agnostic LLM layer, and all Phase-1 middleware are kept intact.

## Rules of execution

1. **One concern per commit.** No mixing scaffold + feature + tests across files unrelated to one purpose.
2. **Every commit compiles and tests pass.** Never push a commit that breaks `main`.
3. **Tests ship with their feature.** A `feat:` commit includes the unit tests for that feature in the same commit. Separate `test:` commits only for adding test infrastructure or back-filling missing coverage.
4. **Conventional commits.** `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `ci:`, `style:`, `refactor:` — with a scope where useful, e.g. `feat(server):`, `feat(frontend):`.
5. **Security review after each batch.** A "batch" = end of a Day or end of a Phase. Process documented below.
6. **No force-pushes to main.** Mistakes get a follow-up commit, not a rewrite.
7. **Architecture enforcer runs before every commit.** Before writing code, check: is this the right layer? Is it the smallest responsibility that makes sense? Will the file cross the size limit? If yes — extract first, commit second. The planned file layout in `architecture-plan-codebase-assistant.md` is the source of truth.

---

## Security review process (between batches)

After each batch (end of Day or end of Phase), spawn a security-review subagent with this prompt template:

```
Review the diff between commits {start_sha} and {end_sha} in this repo.

Check for:
 1. Secrets or credentials committed in plaintext (any string matching ghp_,
    github_pat_, sk-, xox[abprs]-, eyJ... JWTs, PEM key blocks)
 2. Missing input validation on routes (every route validates via the shared
    api-contracts Zod schemas)
 3. Authentication / authorization bypasses (every protected route runs through
    auth middleware; tenant scoping enforced)
 4. Cross-repo isolation bypasses (repoScope.service.ts is the ONLY gate that
    turns a request into allowedRepos; no tool may call GitHub for a repo that
    is not in that set)
 5. Injection vectors (SQL, command, prompt injection — LLM providers use their
    dedicated system-prompt + tool-result mechanisms; retrieved code is wrapped
    in untrusted-data markers)
 6. Tool-calling abuse (agent loop enforces MAX_TURNS and MAX_TOOL_CALLS; tool
    arguments are validated; the createIssue tool is gated to
    tenant.issueConfig.targetRepo and never to arbitrary tenant.repos entries)
 7. Insecure dependencies introduced (package.json additions, no known CVEs)
 8. Secrets logged or returned in error messages
 9. Cross-tenant data access (any DB query must filter by tenant_id)
10. CORS misconfiguration (overly permissive origins outside dev mode)
11. Rate limiting bypasses
12. Token storage (API keys must be hashed; GitHub tokens only in env vars)
13. Repo-map content sanitisation (rendered map fragments never contain raw
    secret-shaped strings from the source files — signatures + names only)

Report findings as: [SEVERITY] [FILE:LINE] [DESCRIPTION] [RECOMMENDED FIX]
Severity: CRITICAL / HIGH / MEDIUM / LOW / INFO

If no issues, say so explicitly. Do not invent issues to look thorough.
```

The reviewer agent is invoked via the Task tool with `subagent_type=generalPurpose` (or `explore` in readonly mode for speed). Findings are addressed in fix-up commits before proceeding to the next batch.

---

## Phase 1 — SHIPPED (Commits 1–26)

Commits 1–26 delivered:

- Monorepo skeleton, Fastify server, shared package with Zod contracts
- Structured logging (Pino), error tracking (Sentry), domain errors, `APP_MODE` config
- Postgres migrations (`conversations`, `analytics_events`, `api_keys`), migration runner
- Tenant config loader with secret-scan (GitHub PATs, Slack tokens, PEM blocks, JWTs)
- Middleware chain: CORS, auth (shared key in prototype, hashed tenant keys in production), tenantResolver, rateLimiter, errorHandler
- Health route (with deep variant), Supabase client, GitHub client (Phase-1 search + read), provider-agnostic LLM layer (OpenAI / Claude / Gemini) with per-tenant spend caps
- Conversation, analytics, and API-key repositories
- `aiService` (Phase-1 version: history → GitHub keyword search → LLM → save → log)
- `apiKeyService` + `scripts/createApiKey.ts`
- `POST /api/v1/chat` route with prompt-injection tests (parametrized × 3 providers)
- GitHub Actions (CI, secret-scan, Dependabot), Render deployment blueprint + Supabase setup

**Phase 1 security reviews completed:** end of Day 1, end of Day 2, end of Phase 1. All findings remediated.

**Phase 1 deployed milestone:** live on Render + Supabase. `curl /api/v1/health` returns `appMode: "prototype"` with DB check `ok`. Tenant API keys mint and verify.

**Phase 1 learning that motivates the pivot:** GitHub's `/search/code` keyword API returns zero context for most natural-language support questions; queries with metacharacters 422; newly-pushed repos are indexing-lagged. A support agent asking "can a trial-plan customer get emails when the resource library opt-in is filled?" gets a hallucinated answer with empty `reposSearched` and `filesReferenced`. The retrieval layer is the bottleneck, not the LLM. Phase 2 replaces it.

---

## Phase 2: Retrieval pivot — repo map + agent loop + per-repo scoping (Commits 27–49)

Rewires the backend so the model navigates the codebase via tools against a pre-built repo map, with strict per-repo scoping enforced at request validation, prompt construction, and tool execution. No frontend work in this phase — Phase 3 owns that. Issue creation becomes a tool call, not a separate route.

### Day 4 — Repo map foundation (Commits 27–34)

```
27. chore(server): add tree-sitter runtime + grammars
    - packages/server/package.json deps: tree-sitter, tree-sitter-typescript,
      tree-sitter-javascript, tree-sitter-python, tree-sitter-php,
      tree-sitter-go (cover AM's stack; more can be added per tenant later)
    - smoke script: parse a fixture file, assert > 0 symbols extracted
    - NO business logic in this commit; only dependencies + smoke

28. feat(infra): add treeSitter.ts wrapper
    - infrastructure/treeSitter.ts: parse(buffer, language) → Array<{
        symbol: string, kind: "class"|"function"|"method"|"const"|"type",
        lineStart: number, lineEnd: number, signature: string
      }>
    - language picked by file extension; unknown extensions return []
    - treeSitter.test.ts: parses TS, JS, Python, PHP, Go fixtures
    - File stays under 150 lines — one responsibility: parse a buffer

29. feat(infra): rename githubMcp.ts → githubClient.ts and extend
    - infrastructure/githubClient.ts (renamed, re-exports toSearchQuery so
      existing tests keep passing) — extend with: getRepo, listDir,
      getCommitSha, readFileRange (pass start/end line, clamp at file length)
    - keep searchCode + readFile from Phase 1 (searchCode stays as a fallback
      tool later); the keyword search is no longer the retrieval primary
    - githubClient.test.ts covers new methods; old tests continue to pass
    - This is an infrastructure file — no logic beyond HTTP wrapping

30. feat(db): add migration 002_repo_maps.sql
    - db/migrations/002_repo_maps.sql — repo_maps table per architecture plan
    - scripts/migrate.test.ts: asserts the new table exists after migration

31. feat(repo): add repoMap.repository.ts
    - repositories/repoMap.repository.ts:
        upsertMap(tenantId, repoFullName, defaultBranch, headSha, content, symbolCount)
        getMap(tenantId, repoFullName)
        listMapsForTenant(tenantId)
    - repoMap.repository.test.ts (mocked Supabase: every query filters tenant_id)
    - repoMap.repository.integration.test.ts (real local Postgres: cross-tenant
      read returns empty; upsert is idempotent)

32. feat(service): add repoMap.service.ts
    - services/repoMap.service.ts:
        build(tenantRepo) — walks the repo via githubClient.listDir, fetches
          each eligible file, parses via treeSitter, renders a text outline
          with line ranges, upserts via repoMap.repository
        refresh(tenantRepo) — no-op if headSha unchanged; otherwise build()
        renderForScope(tenant, allowedRepos) — loads maps for allowedRepos
          ONLY; returns the concatenated text fragment ready for a system
          prompt. Never renders repos outside allowedRepos.
    - repoMap.service.test.ts:
        build() calls treeSitter.parse for each returned file, calls
          repoMap.repository.upsertMap exactly once per repo
        refresh() is idempotent on unchanged SHA
        renderForScope() snapshot test: out-of-scope repos do not appear in
          the rendered string (regex search on the output)
        sanitisation: secret-shaped strings from source files are stripped
          from signatures before render (defence in depth; secrets should
          never be in source anyway, but this prevents accidental surfacing)

33. feat(scripts): add scripts/refreshRepoMaps.ts
    - scripts/refreshRepoMaps.ts — CLI: loads all tenant configs, calls
      repoMap.service.refresh() for each (tenant, repo) pair, logs progress
    - idempotent; safe to run on a cron
    - npm script "refresh-maps" wired in

34. feat(config): add defaultRepoScope to tenant schema
    - config/tenants.schema.ts: add optional defaultRepoScope: string[]
      (each entry must match "owner/name" regex and reference a repo in
      tenant.repos — validated with a z.refine())
    - tenants/_template.json updated with an annotated example
    - tenants/team-alpha.json updated with defaultRepoScope set to
      ["chukxoka4/advanced-troubleshooter"]
    - tenants.test.ts: defaultRepoScope with a repo not in repos fails
      validation; omitted field is allowed (undefined)
```

**End of Day 4 — no security review.** Day 4 is foundation (data structures + infra). Day 5 lands the agent loop and isolation gate, which is the security-critical surface; we review after Day 5 rather than twice in two days.

### Day 5 — Agent loop, scoping gate, and tools (Commits 35–43)

```
35. feat(service): add repoScope.service.ts
    - services/repoScope.service.ts — pure, no I/O. Exports:
        validate(request: { repoScope?: string[] }, tenant: Tenant)
          → { allowedRepos: ReadonlyArray<TenantRepo> }
      If repoScope is undefined: falls back to tenant.defaultRepoScope, then
      to tenant.repos. If any repoScope entry is not in tenant.repos: throws
      ValidationError with the explicit message "repo not in tenant scope"
      (does NOT echo the attempted repo back, to avoid enumeration via errors).
    - repoScope.service.test.ts covering all branches + Object.isFrozen on
      the returned array
    - File is <80 lines — deliberately small. This is the single gate.

36. feat(infra/llm): extend LlmProvider interface for tool calling
    - infrastructure/llm/types.ts: extend LlmProvider with:
        sendMessageWithTools(input: {
          systemPrompt: string, history: Message[], userMessage: string,
          tools: ToolSpec[]
        }): Promise<ToolCallingResult>
      where ToolCallingResult includes either a final answer OR an array of
      pending tool calls, plus usage metrics
    - ToolSpec / ToolCall / ToolResult types defined here (one place)
    - types.test.ts: contract shape test

37. feat(infra/llm): openai sendMessageWithTools
    - infrastructure/llm/openaiProvider.ts: implement via `tools` param and
      message.tool_calls on Chat Completions API
    - openaiProvider.test.ts: tool schema is forwarded; tool_calls are
      decoded into ToolCall[]; spend cap still enforced

38. feat(infra/llm): claude sendMessageWithTools
    - infrastructure/llm/claudeProvider.ts: implement via `tools` param and
      tool_use / tool_result content blocks on Messages API
    - claudeProvider.test.ts covers tool-use decode + spend cap

39. feat(infra/llm): gemini sendMessageWithTools
    - infrastructure/llm/geminiProvider.ts: implement via
      functionDeclarations + functionCall / functionResponse
    - geminiProvider.test.ts covers functionCall decode + spend cap

40. feat(service/tools): add readFile tool
    - services/tools/readFile.tool.ts:
        exports name, description, jsonSchema, execute(args, ctx)
        execute: validates args.repo ∈ ctx.allowedRepos (throws if not);
          calls githubClient.readFileRange with clamped start/end; returns
          { path, lineStart, lineEnd, content } as a string for the model
        binary files → returns "binary file, not readable"
    - readFile.tool.test.ts:
        rejects out-of-scope repo (githubClient NOT called)
        clamps ranges beyond file length
        binary file returns the expected marker

41. feat(service/tools): add searchCode tool
    - services/tools/searchCode.tool.ts — keyword search via githubClient,
      but restricted to ctx.allowedRepos; returns top N hits with paths
      and line snippets (not whole files)
    - searchCode.tool.test.ts: scope enforcement; multi-repo scoped search
      makes one call per allowed repo, zero for non-allowed

42. feat(service/tools): add findSymbol tool
    - services/tools/findSymbol.tool.ts — reads the repoMap.repository maps
      for ctx.allowedRepos, searches for a symbol name, returns
      { repo, path, lineStart, lineEnd, signature } matches (no file read)
    - findSymbol.tool.test.ts: only scans allowed repos; unknown symbol
      returns empty array, not an error

43. feat(service): add agentLoop.service.ts
    - services/agentLoop.service.ts:
        run({ tenant, allowedRepos, history, systemPrompt, userMessage,
              tools, maxTurns = 8, maxToolCalls = 16 }) → {
          answer, filesReferenced, toolCalls, usage, cost
        }
        dispatcher: on every tool call, re-validates args.repo ∈ allowedRepos
          (defence in depth; the tools also validate — belt + braces). If
          not allowed, returns an error tool result to the model and does
          NOT invoke the tool.
        caps: stops at maxTurns; if maxToolCalls is exceeded, forces a
          final answer with a partial-result marker
    - agentLoop.service.test.ts:
        respects maxTurns
        dispatcher rejects out-of-scope repo arg — mocked tool NEVER called
        collects filesReferenced from successful readFile calls
        propagates provider errors; does not swallow them
```

**End of Day 5 — Security review batch #4 (pivot core).** Focus: the scoping gate (three-layer), the tool dispatcher, prompt injection via tool-result content (is retrieved file content properly wrapped as untrusted data inside the tool-result path?), and tool-arg validation for `createIssue` preview. This is the batch that most changes the threat model and deserves the deepest review.

### Day 6 — Scoping API surface + issue tools + route rewire (Commits 44–49)

```
44. refactor(service): rewire aiService to use the agent loop
    - services/aiService.ts: shrinks to orchestration only —
        history via conversationRepository
        allowedRepos via repoScope.service.validate
        systemPrompt = tenant.systemPrompt + repoMap.service.renderForScope
        result = agentLoop.service.run({...})
        save messages, log analytics (incl. toolCallCount, reposScoped)
    - Phase-1 keyword-search code path (inline githubMcp.searchFiles /
      readFile loop, buildContextBlock) is DELETED in the same commit
    - aiService.test.ts rewritten against the new orchestration; the old
      Phase-1 assertions move to agentLoop.service.test.ts where they
      still apply
    - File size check: aiService drops to ~100 lines (well under 200)

45. feat(shared): update api-contracts for repoScope + rich citations
    - packages/shared/src/api-contracts.ts:
        ChatRequestSchema gains optional repoScope: string[] (owner/name
          regex on each entry)
        ChatCitationSchema gains lineStart?: number, lineEnd?: number
        ChatResponseSchema gains reposScoped, reposTouched, toolCalls?
        new TenantReposResponseSchema
    - api-contracts.test.ts: new fields validated; bad shapes rejected

46. feat(routes): /chat accepts repoScope
    - routes/chat.ts: pass request.repoScope into aiService; let
      ValidationError from repoScope.service bubble to the errorHandler
      middleware (which maps it to 400)
    - chat.route.test.ts: repoScope in body forwarded to aiService;
      unknown repo → 400 with generic ValidationError message (does not
      echo the attempted repo name)

47. feat(routes): add GET /api/v1/tenant/repos
    - routes/tenantRepos.ts: reads req.tenant (set by tenantResolver),
      returns TenantReposResponse with isDefault flag for each repo
    - tenantRepos.route.test.ts: auth required, returns expected shape,
      isDefault reflects tenant.defaultRepoScope
    - Route stays under 30 lines (controller rule)

48. feat(infra): add issueCreator.ts
    - infrastructure/issueCreator.ts: create(repoFullName, { title, body,
      labels }, writeToken) → { url, number }
    - issueCreator.test.ts: correct endpoint, correct auth header, propagates
      4xx as a typed error (ValidationError for 422, ForbiddenError for 403)

49. feat(service/tools): add createIssue + searchIssues tools
    - services/tools/createIssue.tool.ts:
        validates args.repo === tenant.issueConfig.targetRepo (tighter
          than allowedRepos — issue creation is scoped to ONE repo)
        calls issueCreator.create with tenant.issueConfig.writeToken
        returns { url, number } to the model
    - services/tools/searchIssues.tool.ts:
        validates args.repo === tenant.issueConfig.targetRepo
        calls githubClient (issues search) with the READ token
        returns titles + URLs only (no bodies; cheap + safe)
    - tests for both cover scope enforcement
    - agentLoop: register createIssue + searchIssues in the default tool
      registry; both are conditionally included only when
      tenant.issueConfig?.writeToken is present
```

**End of Phase 2 — Security review batch #5 + milestone check.**

**Phase 2 milestone:**
```
# A — natural language → code-grounded answer with line ranges
curl -X POST https://<render-url>/api/v1/chat \
  -H "Authorization: Bearer $KEY" \
  -H "X-Tenant-Id: team-alpha" \
  -H "Content-Type: application/json" \
  -d '{ "sessionId": "<uuid>", "message": "Where does the assistant
        validate that a requested repo belongs to the tenant?",
        "repoScope": ["chukxoka4/advanced-troubleshooter"] }'
# → answer cites services/repoScope.service.ts with a precise line range

# B — issue creation via tool call
curl -X POST https://<render-url>/api/v1/chat \
  -H "Authorization: Bearer $KEY" \
  -H "X-Tenant-Id: team-alpha" \
  -H "Content-Type: application/json" \
  -d '{ "sessionId": "<uuid>", "message": "File a bug: the repo-map
        refresh script does not retry on transient GitHub 5xx. Include a
        code reference and suggest a fix." }'
# → response contains a GitHub issue URL; repo shows the new issue
```

---

## Phase 3: Frontend (Commits 50–59)

Both entry points are built in the same phase so we never have to rearchitect a full-page app into a widget — the components are written once, the shells differ. The repo picker is a first-class component wired from Day 7.

### Day 7 — Frontend foundations + repo picker (Commits 50–54)

```
50. chore(frontend): scaffold Vite + React + TypeScript
    - packages/frontend/package.json (vite, react, typescript)
    - packages/frontend/tsconfig.json
    - packages/frontend/vite.config.ts (single app target for now)
    - packages/frontend/.env.example: VITE_API_URL, VITE_TENANT_ID,
      VITE_API_KEY

51. feat(frontend): add config module (dual mode)
    - src/config.ts: reads import.meta.env in app mode; reads HTML
      attributes (via a setter called from widget.tsx) in widget mode.
      No direct document.body or window access elsewhere in the codebase.
    - config.test.ts: both code paths return correct values

52. feat(frontend): add typed API client
    - src/services/apiClient.ts: imports Zod schemas from packages/shared
      and parses responses through them (no untyped .json() usage)
    - apiClient.test.ts (mocked fetch): sends expected bodies, parses
      responses, surfaces typed errors for non-2xx

53. feat(frontend): add session + chat + repoScope hooks
    - src/hooks/useSession.ts (UUIDv4, localStorage, session-scoped)
    - src/hooks/useChat.ts (message state, calls apiClient.chat)
    - src/hooks/useRepoScope.ts (fetches /tenant/repos once, tracks
      current selection, seeds from isDefault flags; resets when the
      tab closes — sessionStorage, not localStorage)
    - tests for each hook

54. feat(frontend): add RepoPicker component
    - src/components/RepoPicker.tsx: multi-select pill row. Each pill
      is one repo. Selected pills visually distinct. Accessible keyboard
      interaction. Calls useRepoScope's toggle.
    - RepoPicker.test.tsx: renders tenant repos; pre-selects isDefault;
      toggling updates the state; no document.body access
```

### Day 8 — Chat UI + entry points + deploy (Commits 55–59)

```
55. feat(frontend): build core chat components
    - ChatWindow, MessageBubble, InputBar, CodeCitation — each <200 lines
    - CodeCitation renders repo + path + optional line range and an "open
      in GitHub" link built from the citation shape
    - CSS Modules, no global selectors
    - components.test.tsx

56. feat(frontend): main.tsx (prototype entry)
    - src/main.tsx — renders <ChatWindow> with <RepoPicker> above the
      <InputBar> into <div id="root">
    - index.html
    - npm run dev works against the deployed Render backend

57. feat(frontend): widget.tsx (production entry)
    - src/widget.tsx — defines <codebase-assistant> custom element,
      mounts the same <ChatWindow> into Shadow DOM, reads api-url,
      tenant-id, api-key, and OPTIONAL repo-scope from HTML attributes
      (repo-scope="owner/a,owner/b" seeds the picker)
    - widget.test.ts: registers, attributes parsed, Shadow DOM isolated,
      repo-scope attribute pre-seeds useRepoScope

58. feat(frontend): dual build targets
    - vite.config.ts: build:app (SPA) + build:widget (single JS with
      inlined CSS, suitable for drop-in embed)
    - manual verification: drop the widget JS into a plain HTML page,
      confirm the custom element renders and talks to the backend

59. chore(frontend): deploy to Vercel
    - vercel.json or framework auto-detection
    - deploy; verify both entry points work end-to-end
```

**End of Phase 3 — Security review batch #6 + milestone check.**

Phase 3 milestone: Vercel URL opens, picker fetches the tenant's repos, agent toggles the scope, asks a question, gets an answer with exact line citations. The widget JS loads into a plain HTML page and behaves identically.

---

## Phase 4: Multi-tenant hardening + production switch (Commits 60–67)

```
60. feat(tenants): add a second tenant with a different provider
    - tenants/team-beta.json (different repos, different LLM provider —
      e.g. team-alpha = OpenAI, team-beta = Claude)
    - .env.example updated with team-beta's keys

61. test(server): add isolation suite
    - tests/isolation.test.ts covering:
        cross-tenant access via spoofed body tenantId → rejected
        cross-tenant session ID reuse → empty history returned
        cross-repo: repoScope names a repo in a different tenant → 400
        cross-repo: LLM tool call with out-of-scope repo → dispatcher
          rejects; githubClient NOT called (mocked)
        snapshot: rendered system prompt contains only in-scope repos
        issue creation: target repo not equal to tenant.issueConfig.
          targetRepo → tool rejects; issueCreator NOT called
        DB assertion: every conversations + repo_maps row has a valid
          tenant_id
    - This is a hard merge blocker: if it fails, no release

62. test(e2e): Playwright suite
    - packages/e2e/chat.spec.ts          — ask question with scope, get citation
    - packages/e2e/repoPicker.spec.ts    — toggle scope changes results
    - packages/e2e/issueCreate.spec.ts   — ask model to file an issue, verify
                                          URL appears and issue exists in GH
    - packages/e2e/auth.spec.ts          — no key → 401, UI shows error state
    - packages/e2e/embed.spec.ts         — widget drops into plain HTML and
                                          completes the full flow
    - CI job runs Playwright against staging URL on every PR

63. feat(frontend): thumbs-up/down feedback
    - feedback buttons on each assistant message
    - apiClient.recordFeedback() → backend logs to analytics_events.
      metadata (eventType = "feedback")
    - tests for both sides

64. feat(server): repo-map refresh webhook
    - POST /api/v1/internal/repo-map-refresh — validates GitHub HMAC
      signature via a shared secret per tenant in tenant config
      (tenant.webhook?.secret); on valid push event for a known repo,
      triggers repoMap.service.refresh() in the background
    - webhook.route.test.ts: invalid signature → 401; valid signature on
      unknown repo → 404; valid signature on known repo → 202 Accepted
    - docs/webhook-setup.md — one-pager for teams to wire a GitHub
      webhook against their repo

65. docs: onboarding.md
    - 6-step team self-service guide:
        1. Create GitHub fine-grained PAT (contents:read)
        2. (Optional) second PAT for issues:write on the target repo
        3. Copy tenants/_template.json → tenants/<team>.json, fill in
           repos, defaultRepoScope, systemPrompt, issueConfig
        4. Set env vars for the two tokens and the LLM API key
        5. Open a PR — CI runs the secret-scan; merge
        6. (Optional) set up the refresh webhook for instant map updates

66. docs: production-deploy.md
    - 10-step prototype → production switch:
        1. APP_MODE=production in Render
        2. Mint per-tenant API keys via scripts/createApiKey.ts
        3. Populate per-tenant allowedOrigins in tenants/*.json
        4. Populate per-tenant rateLimits
        5. Set SENTRY_DSN to activate error tracking
        6. Rotate the API_KEY_PEPPER and re-mint all keys
        7. Switch frontend deploy from build:app to build:widget
        8. Verify GET /health returns appMode: "production"
        9. Run Playwright suite against staging
       10. Flip DNS / embed snippet in the ticketing tool

67. chore: APP_MODE=production flip
    - verify health check confirms production mode
    - verify per-tenant CORS enforced (curl from an unlisted origin → 403)
    - verify per-tenant rate limits enforced
    - run full Playwright suite against the production-mode deployment
    - close Phase 4 milestone in this document
```

**End of Phase 4 — Security review batch #7 (final).**

Final milestone: two isolated tenants on different LLM providers, with distinct repos and distinct rate limits. Production mode active. `isolation.test.ts` green. Playwright E2E green against the production deployment. Onboarding and deploy docs ready. An AM team-mate, given only `docs/onboarding.md`, can add a third tenant without contacting you.

---

## Total commit count

| Phase | Commits | Security reviews |
|---|---|---|
| Phase 1 (shipped) | 26 | 3 (end of Day 1, Day 2, Phase 1) |
| Phase 2 | 23 (27–49) | 2 (end of Day 5, end of Phase 2) |
| Phase 3 | 10 (50–59) | 1 (end of Phase 3) |
| Phase 4 | 8 (60–67) | 1 (end of Phase 4) |
| **Total** | **67** | **7** |

---

## What "build complete" means

- All 67 commits land on `main`
- All 7 security reviews pass with no CRITICAL or HIGH findings outstanding
- CI is green
- Health check on production deployment returns `appMode: "production"`
- `tests/isolation.test.ts` passes (tenant + cross-repo isolation)
- E2E suite passes against the production deployment, including the repo-picker scope test and the embed test
- Two tenants operational on different LLM providers
- An AM team-mate, given only the URL of `docs/onboarding.md`, can add a third tenant without contacting you

That is the bar.
