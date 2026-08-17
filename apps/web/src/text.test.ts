import { describe, expect, test } from "bun:test";
import { titleFromPrompt } from "./text";

describe("titleFromPrompt", () => {
  test("normalizes whitespace", () => {
    expect(titleFromPrompt("  Payment   API with Postgres ")).toBe(
      "Payment API with Postgres",
    );
  });

  test("keeps generated project titles bounded", () => {
    const title = titleFromPrompt("A very long architecture prompt ".repeat(5));
    expect(title.length).toBeLessThanOrEqual(64);
    expect(title.endsWith("…")).toBe(true);
  });
});
