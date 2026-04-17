import type { DatabasePool } from "../infrastructure/db.js";

/**
 * Analytics repository. Writes one row per observable event (query,
 * issue_draft, issue_created, feedback). Reads are not exposed here — the
 * prototype relies on Supabase's table viewer for ad-hoc analysis.
 */

export type AnalyticsEventType =
  | "query"
  | "issue_draft"
  | "issue_created"
  | "feedback";

export interface LogEventInput {
  tenantId: string;
  sessionId: string;
  eventType: AnalyticsEventType;
  latencyMs?: number;
  reposCount?: number;
  feedbackRating?: number;
  metadata?: Record<string, unknown>;
}

export interface AnalyticsRepository {
  logEvent(input: LogEventInput): Promise<void>;
}

export function createAnalyticsRepository(db: DatabasePool): AnalyticsRepository {
  return {
    async logEvent(input) {
      if (!input.tenantId) throw new Error("analytics.logEvent: tenantId is required");
      if (
        input.feedbackRating !== undefined &&
        (input.feedbackRating < 1 || input.feedbackRating > 5)
      ) {
        throw new Error("analytics.logEvent: feedbackRating must be between 1 and 5");
      }
      await db.query(
        `INSERT INTO analytics_events
           (tenant_id, session_id, event_type,
            latency_ms, repos_count, feedback_rating, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.tenantId,
          input.sessionId,
          input.eventType,
          input.latencyMs ?? null,
          input.reposCount ?? null,
          input.feedbackRating ?? null,
          input.metadata ? JSON.stringify(input.metadata) : null,
        ],
      );
    },
  };
}
