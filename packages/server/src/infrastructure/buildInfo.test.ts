import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadBuildInfo } from "./buildInfo.js";

describe("loadBuildInfo", () => {
  const originalRailway = process.env.RAILWAY_GIT_COMMIT_SHA;
  const originalGitSha = process.env.GIT_SHA;

  beforeEach(() => {
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    delete process.env.GIT_SHA;
  });

  afterEach(() => {
    process.env.RAILWAY_GIT_COMMIT_SHA = originalRailway;
    process.env.GIT_SHA = originalGitSha;
  });

  it("reads the version from package.json", async () => {
    const info = await loadBuildInfo();
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("returns null gitSha when neither env var is set", async () => {
    const info = await loadBuildInfo();
    expect(info.gitSha).toBeNull();
  });

  it("prefers RAILWAY_GIT_COMMIT_SHA over GIT_SHA", async () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "railway-sha";
    process.env.GIT_SHA = "local-sha";
    const info = await loadBuildInfo();
    expect(info.gitSha).toBe("railway-sha");
  });

  it("falls back to GIT_SHA when RAILWAY_GIT_COMMIT_SHA is unset", async () => {
    process.env.GIT_SHA = "local-sha";
    const info = await loadBuildInfo();
    expect(info.gitSha).toBe("local-sha");
  });
});
