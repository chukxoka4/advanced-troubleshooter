import { Writable } from "node:stream";
import { describe, it, expect } from "vitest";
import { createLoggerWithDestination } from "./logger.js";

function collect(): { stream: Writable; lines: () => Array<Record<string, unknown>> } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("logger", () => {
  it("emits structured JSON with the context fields on every line", () => {
    const { stream, lines } = collect();
    const log = createLoggerWithDestination(
      { request_id: "req-1", tenant_id: "team-alpha", session_id: "sess-42" },
      stream,
    );

    log.info("hello");
    log.warn({ extra: "field" }, "warn-line");

    const parsed = lines();
    expect(parsed).toHaveLength(2);
    for (const line of parsed) {
      expect(line.request_id).toBe("req-1");
      expect(line.tenant_id).toBe("team-alpha");
      expect(line.session_id).toBe("sess-42");
      expect(line.service).toBe("advanced-troubleshooter-server");
      expect(typeof line.level).toBe("string");
      expect(typeof line.time).toBe("string");
    }
    expect(parsed[0]?.msg).toBe("hello");
    expect(parsed[1]?.msg).toBe("warn-line");
    expect(parsed[1]?.extra).toBe("field");
  });

  it("omits undefined context fields rather than emitting empty keys", () => {
    const { stream, lines } = collect();
    const log = createLoggerWithDestination({ request_id: "req-2" }, stream);

    log.info("only request id");

    const line = lines()[0];
    expect(line).toBeDefined();
    expect(line?.request_id).toBe("req-2");
    expect(line).not.toHaveProperty("tenant_id");
    expect(line).not.toHaveProperty("session_id");
  });
});
