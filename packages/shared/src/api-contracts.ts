import { z } from "zod";

/**
 * API request/response contracts shared between the server and the frontend.
 *
 * Intentionally empty for now: schemas are added alongside the routes that
 * validate against them (chat in commit #25, issue draft/create in Phase 3).
 * Keeping the file present with Zod imported means later commits only add
 * exports — they never have to first wire up the module.
 */

export const _reservedForFutureContracts = z.object({});
export type _ReservedForFutureContracts = z.infer<typeof _reservedForFutureContracts>;
