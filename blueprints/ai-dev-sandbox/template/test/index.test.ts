import { describe, it, expect } from "vitest";

describe("{{projectName}}", () => {
  it("has a fetch handler", () => {
    expect(typeof fetch).toBe("function");
  });

  it("is a valid worker project", () => {
    expect("{{projectName}}").toMatch(/^[a-z0-9-]+$/);
  });
});