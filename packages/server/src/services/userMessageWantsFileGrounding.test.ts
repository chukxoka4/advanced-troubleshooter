import { describe, expect, it } from "vitest";
import { userMessageWantsFileGrounding } from "./userMessageWantsFileGrounding.js";

describe("userMessageWantsFileGrounding", () => {
  it("is true for path-like and read-file phrasing", () => {
    expect(
      userMessageWantsFileGrounding(
        "Read the file packages/server/src/services/repoScope.service.ts and explain",
      ),
    ).toBe(true);
    expect(userMessageWantsFileGrounding("line by line what validate does")).toBe(true);
    expect(userMessageWantsFileGrounding("show me the exact code in foo.ts")).toBe(true);
  });

  it("is true for services/…ts style paths", () => {
    expect(userMessageWantsFileGrounding("Explain services/foo/bar.service.ts validate()")).toBe(true);
  });

  it("is false for generic conceptual questions", () => {
    expect(userMessageWantsFileGrounding("Where is repo scope validated?")).toBe(false);
    expect(userMessageWantsFileGrounding("Hello")).toBe(false);
  });
});
