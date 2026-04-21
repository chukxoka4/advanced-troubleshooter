import { describe, expect, it, vi } from "vitest";
import { ForbiddenError, ValidationError } from "../shared/errors/index.js";
import { createIssueCreator } from "./issueCreator.js";

function jsonResponse(body: unknown, init: Partial<ResponseInit> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 201,
    statusText: init.statusText ?? "Created",
    headers: { "Content-Type": "application/json" },
  });
}

describe("issueCreator", () => {
  it("POSTs to /repos/{owner}/{repo}/issues with Bearer write token", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ html_url: "https://github.com/acme/widgets/issues/42", number: 42 }),
    );
    const creator = createIssueCreator({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await creator.create(
      "acme/widgets",
      { title: "Bug", body: "Details", labels: ["bug"] },
      "ghs_write",
    );
    expect(out).toEqual({ url: "https://github.com/acme/widgets/issues/42", number: 42 });
    const [calledUrl, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://api.github.com/repos/acme/widgets/issues");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ghs_write");
    expect(JSON.parse(init.body as string)).toEqual({ title: "Bug", body: "Details", labels: ["bug"] });
  });

  it("maps HTTP 422 to ValidationError", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 }),
    );
    const creator = createIssueCreator({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      creator.create("acme/widgets", { title: "x", body: "y" }, "tok"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("maps HTTP 403 to ForbiddenError", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 403, statusText: "Forbidden" }));
    const creator = createIssueCreator({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      creator.create("acme/widgets", { title: "x", body: "y" }, "tok"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
