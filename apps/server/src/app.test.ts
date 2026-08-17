import { describe, expect, test } from "bun:test";
import { app } from "./app";

describe("server routes", () => {
  test("returns health status", async () => {
    const response = await app.handle(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "archverse-server",
    });
  });

  test("returns a validated fallback plan", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "A user-facing API with a queue" }),
      }),
    );
    const body = (await response.json()) as {
      source: string;
      commands: unknown[];
    };
    expect(response.status).toBe(200);
    expect(body.source).toBe("demo");
    expect(body.commands.length).toBeGreaterThan(1);
  });

  test("rejects a short prompt", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "x" }),
      }),
    );
    expect(response.status).toBe(422);
  });
});
