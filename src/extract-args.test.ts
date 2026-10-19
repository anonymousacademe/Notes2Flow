import { describe, expect, it } from "vitest";
import { parseArgs } from "./extract.js";

describe("extract CLI numeric flags", () => {
  it("uses the defaults when the flags are absent", () => {
    const args = parseArgs(["--input", "notes.md"]);
    expect(args.timeoutMs).toBe(300_000);
    expect(args.chunkSize).toBe(12000);
  });

  it("converts --timeout seconds to milliseconds and reads --chunk-size", () => {
    const args = parseArgs(["--input", "notes.md", "--timeout", "45", "--chunk-size", "4000"]);
    expect(args.timeoutMs).toBe(45_000);
    expect(args.chunkSize).toBe(4000);
  });

  it("rejects a flag that consumed the next flag as its value instead of producing NaN", () => {
    expect(() => parseArgs(["--input", "notes.md", "--timeout", "-g", "medium"])).toThrow(
      'Invalid --timeout "-g"',
    );
    expect(() => parseArgs(["--input", "notes.md", "--chunk-size", "-i", "x.md"])).toThrow(
      'Invalid --chunk-size "-i"',
    );
  });

  it("rejects zero, negative and non-numeric values", () => {
    for (const bad of ["0", "-5", "abc", ""]) {
      expect(() => parseArgs(["--input", "notes.md", "--timeout", bad])).toThrow(/Invalid --timeout/);
    }
  });
});
