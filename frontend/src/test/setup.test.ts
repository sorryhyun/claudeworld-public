import "./setup";
import { describe, it, expect } from "bun:test";

describe("Test Setup", () => {
  it("should run tests successfully", () => {
    expect(true).toBe(true);
  });

  it("should have access to a DOM", () => {
    expect(typeof document).toBe("object");
    expect(document.body).toBeDefined();
  });
});
