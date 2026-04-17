# Deploying the prototype to Render + Supabase

First-deploy playbook. Assumes you already have a Render account and a
Supabase account (both free tier, no credit card required).

## 1. Provision the database in Supabase

1. Go to <https://supabase.com/dashboard> and click **New project**.
2. Name it (e.g. `advanced-troubleshooter-prototype`), pick the region closest to your Render region, generate a strong database password, and click **Create new project**. Wait ~2 minutes while it provisions.
3. Once ready, open **Settings → Database → Connection string**.
4. Select **URI** and the **Transaction pooler** (port 6543) — the pooler is required for serverless/short-lived connections like our Fastify instance.
5. Copy the connection string. It looks like:
   ```
   postgresql://postgres.<project-ref>:<db-password>@aws-0-<region>.pooler.supabase.com:6543/postgres
   ```
   Keep this open in a tab — you'll paste it into Render shortly.

## 2. Run migrations against Supabase (from your laptop)

Render's build step will NOT run migrations — we run them manually so schema changes are always intentional.

```bash
DATABASE_URL='<paste-supabase-connection-string>' npm run migrate
```

Expected output:
```
apply 001_init.sql
migrations complete: applied=1 skipped=0
```

If you re-run it, it's idempotent: `applied=0 skipped=1`.

## 3. Create the Render Web Service

1. Go to <https://dashboard.render.com> and click **New → Blueprint**.
2. Connect your GitHub account if you haven't; authorise the `advanced-troubleshooter` repo.
3. Render detects `render.yaml` at the repo root and shows a preview of the service it will create. Click **Apply**.
4. Render creates the service and stops at an env-var review screen because several variables are marked `sync: false`.
5. Paste values for:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Supabase pooler URI from step 1 |
   | `TEAM_ALPHA_GH_TOKEN` | a GitHub PAT with repo:read scope for the repo referenced by `packages/server/tenants/team-alpha.json` |
   | `TEAM_ALPHA_ISSUE_TOKEN` | a GitHub PAT with issues:write scope for the same repo (can be the same PAT) |
   | `TEAM_ALPHA_LLM_API_KEY` | your OpenAI (or other provider) API key |

   `SHARED_API_KEY` is generated automatically by Render. Copy it from the dashboard after the first deploy — you'll need it to hit any protected route.

6. Click **Create service**. Build + deploy takes ~2-3 minutes on the free tier.

## 4. Verify the deploy

Once the dashboard shows "Live":

```bash
curl -s https://<your-service>.onrender.com/api/v1/health | jq
```

Expected:
```json
{
  "status": "ok",
  "version": "0.0.0",
  "gitSha": "<the-commit-sha-that-was-deployed>",
  "appMode": "prototype",
  "uptimeMs": 1234,
  "checks": { "database": "ok" }
}
```

The `database: "ok"` line is the important one — it proves the Render service can reach Supabase.

## Expected free-tier behaviour

- **Cold start**: after 15 minutes of inactivity, the service sleeps. The first request then takes ~30-60 seconds (Render boots a fresh container, Fastify starts, the first DB query opens a pool connection). Subsequent requests are fast.
- **Bandwidth**: 100 GB/month — generous for a prototype.
- **Redeploy**: pushing to `main` triggers an auto-deploy (set by `autoDeploy: true` in `render.yaml`).
- **Logs**: visible in the Render dashboard under the service's **Logs** tab.

## When you outgrow the free tier

Signs it's time to upgrade:
- Cold-start latency blocks real users.
- Memory regularly approaches the 512 MB limit (check the **Metrics** tab).
- You want to point a custom domain at the service (free tier supports this, but you need paid for zero-downtime deploys).

Upgrade path: set `plan: starter` in `render.yaml` and push. Starter is \$7/mo and removes cold starts and memory caps.
