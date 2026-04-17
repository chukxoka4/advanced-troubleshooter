import type { DatabasePool } from "../infrastructure/db.js";

/**
 * Conversation repository. All database access for the `conversations`
 * table flows through here so tenant scoping and soft-delete handling live
 * in exactly one place. Every query filters by tenant_id; there is no
 * getter that returns rows without a tenant filter. Soft-deleted rows
 * (deleted_at IS NOT NULL) are excluded from reads.
 */

export type ConversationRole = "agent" | "assistant";

export interface ConversationRow {
  id: string;
  tenantId: string;
  sessionId: string;
  role: ConversationRole;
  message: string;
  reposSearched: string[];
  filesReferenced: string[];
  createdAt: Date;
}

export interface SaveMessageInput {
  tenantId: string;
  sessionId: string;
  role: ConversationRole;
  message: string;
  reposSearched?: string[];
  filesReferenced?: string[];
}

export interface ConversationRepository {
  saveMessage(input: SaveMessageInput): Promise<ConversationRow>;
  getHistory(tenantId: string, sessionId: string, limit?: number): Promise<ConversationRow[]>;
}

interface DbConversationRow {
  id: string;
  tenant_id: string;
  session_id: string;
  role: ConversationRole;
  message: string;
  repos_searched: string[] | null;
  files_referenced: string[] | null;
  created_at: Date;
}

function mapRow(row: DbConversationRow): ConversationRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    role: row.role,
    message: row.message,
    reposSearched: row.repos_searched ?? [],
    filesReferenced: row.files_referenced ?? [],
    createdAt: row.created_at,
  };
}

export function createConversationRepository(db: DatabasePool): ConversationRepository {
  return {
    async saveMessage(input) {
      if (!input.tenantId) throw new Error("conversation.saveMessage: tenantId is required");
      const { rows } = await db.query<DbConversationRow>(
        `INSERT INTO conversations
           (tenant_id, session_id, role, message, repos_searched, files_referenced)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, tenant_id, session_id, role, message,
                   repos_searched, files_referenced, created_at`,
        [
          input.tenantId,
          input.sessionId,
          input.role,
          input.message,
          input.reposSearched ?? [],
          input.filesReferenced ?? [],
        ],
      );
      const row = rows[0];
      if (!row) throw new Error("conversation.saveMessage: insert returned no row");
      return mapRow(row);
    },

    async getHistory(tenantId, sessionId, limit = 50) {
      if (!tenantId) throw new Error("conversation.getHistory: tenantId is required");
      const { rows } = await db.query<DbConversationRow>(
        `SELECT id, tenant_id, session_id, role, message,
                repos_searched, files_referenced, created_at
         FROM conversations
         WHERE tenant_id = $1
           AND session_id = $2
           AND deleted_at IS NULL
         ORDER BY created_at ASC
         LIMIT $3`,
        [tenantId, sessionId, limit],
      );
      return rows.map(mapRow);
    },
  };
}
