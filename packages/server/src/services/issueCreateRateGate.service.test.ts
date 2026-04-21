import { describe, expect, it, vi } from "vitest";
import { RateLimitError } from "../shared/errors/index.js";
import { createIssueCreateRateGate } from "./issueCreateRateGate.service.js";

describe("issueCreateRateGate", () => {
  it("allows up to issuesPerHour creations within the same UTC hour bucket", () => {
    const t0 = Date.UTC(2026, 3, 21, 12, 0, 0);
    const now = vi.fn(() => t0);
    const gate = createIssueCreateRateGate({ now });
    const tenant = { tenantId: "team-a", rateLimits: { questionsPerMinute: 1, issuesPerHour: 2 } };
    gate.tryConsume(tenant);
    gate.tryConsume(tenant);
    expect(() => gate.tryConsume(tenant)).toThrow(RateLimitError);
  });

  it("resets the counter in the next hour bucket", () => {
    let ms = Date.UTC(2026, 3, 21, 12, 0, 0);
    const now = vi.fn(() => ms);
    const gate = createIssueCreateRateGate({ now });
    const tenant = { tenantId: "team-b", rateLimits: { questionsPerMinute: 1, issuesPerHour: 1 } };
    gate.tryConsume(tenant);
    expect(() => gate.tryConsume(tenant)).toThrow(RateLimitError);
    ms += 3_600_000;
    expect(() => gate.tryConsume(tenant)).not.toThrow();
  });
});
