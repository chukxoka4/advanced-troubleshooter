import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "./treeSitter.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(join(__dirname, "__fixtures__", name), "utf8");

describe("treeSitter.parse", () => {
  it("extracts symbols from TypeScript", () => {
    const out = parse(fixture("sample.ts"), "sample.ts");
    const names = out.map((s) => s.symbol);
    expect(names).toContain("distance");
    expect(names).toContain("Vec");
    expect(names).toContain("Point");
    const distance = out.find((s) => s.symbol === "distance");
    expect(distance?.kind).toBe("function");
    expect(distance?.lineStart).toBeGreaterThan(0);
    expect(distance?.lineEnd).toBeGreaterThanOrEqual(distance!.lineStart);
  });

  it("extracts symbols from JavaScript", () => {
    const out = parse(fixture("sample.js"), "sample.js");
    const names = out.map((s) => s.symbol);
    expect(names).toContain("distance");
    expect(names).toContain("Vec");
  });

  it("extracts symbols from Python", () => {
    const out = parse(fixture("sample.py"), "sample.py");
    const names = out.map((s) => s.symbol);
    expect(names).toContain("distance");
    expect(names).toContain("Vec");
    expect(out.find((s) => s.symbol === "Vec")?.kind).toBe("class");
  });

  it("extracts symbols from PHP", () => {
    const out = parse(fixture("sample.php"), "sample.php");
    const names = out.map((s) => s.symbol);
    expect(names).toContain("distance");
    expect(names).toContain("Vec");
  });

  it("extracts symbols from Go", () => {
    const out = parse(fixture("sample.go"), "sample.go");
    expect(out.length).toBeGreaterThan(0);
    const names = out.map((s) => s.symbol);
    expect(names.some((n) => n === "Distance")).toBe(true);
  });

  it("returns [] for unknown extensions", () => {
    expect(parse("whatever", "README.md")).toEqual([]);
    expect(parse("whatever", "noext")).toEqual([]);
  });

  it("accepts Buffer input", () => {
    const out = parse(Buffer.from(fixture("sample.ts"), "utf8"), "x.ts");
    expect(out.length).toBeGreaterThan(0);
  });
});
