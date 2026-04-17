import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadBuildInfo } from "./buildInfo.js";

describe("loadBuildInfo", () => {
  const originalRender = process.env.RENDER_GIT_COMMIT;
  const originalRailway = process.env.RAILWAY_GIT_COMMIT_SHA;
  const originalGitSha = process.env.GIT_SHA;

  beforeEach(() => {
    delete process.env.RENDER_GIT_COMMIT;
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    delete process.env.GIT_SHA;
  });

  afterEach(() => {
    process.env.RENDER_GIT_COMMIT = originalRender;
    process.env.RAILWAY_GIT_COMMIT_SHA = originalRailway;
    process.env.GIT_SHA = originalGitSha;
  });

  it("reads the version from package.json", async () => {
    const info = await loadBuildInfo();
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("returns null gitSha when no env var is set", async () => {
    const info = await loadBuildInfo();
    expect(info.gitSha).toBeNull();
  });

  it("prefers RENDER_GIT_COMMIT over every other source", async () => {
    process.env.RENDER_GIT_COMMIT = "render-sha";
    process.env.RAILWAY_GIT_COMMIT_SHA = "railway-sha";
    process.env.GIT_SHA = "local-sha";
    const info = await loadBuildInfo();
    expect(info.gitSha).toBe("render-sha");
  });

  it("falls back to RAILWAY_GIT_COMMIT_SHA when RENDER_GIT_COMMIT is unset", async () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "railway-sha";
    process.env.GIT_SHA = "local-sha";
    const info = await loadBuildInfo();
    expect(info.gitSha).toBe("railway-sha");
  });

  it("falls back to GIT_SHA when the host-provided SHAs are unset", async () => {
    process.env.GIT_SHA = "local-sha";
    const info = await loadBuildInfo();
    expect(info.gitSha).toBe("local-sha");
  });
});
