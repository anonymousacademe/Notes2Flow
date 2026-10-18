import { describe, expect, it } from "vitest";
import { COMPACT_MODEL, defaultModelFor } from "./models.js";

describe("defaultModelFor", () => {
  it("uses the compact model for low granularity", () => {
    expect(defaultModelFor("low", "z-ai/glm-5.3-flash")).toBe(COMPACT_MODEL);
  });

  it("keeps the fallback for medium and high", () => {
    expect(defaultModelFor("medium", "z-ai/glm-5.3-flash")).toBe("z-ai/glm-5.3-flash");
    expect(defaultModelFor("high", "anthropic/claude-sonnet-5.5")).toBe("anthropic/claude-sonnet-5.5");
  });
});
