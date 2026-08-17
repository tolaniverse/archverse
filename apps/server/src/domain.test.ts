import { describe, expect, test } from "bun:test";
import { canWriteProject, hasActivePro, type Project } from "./domain";
import { emptyArchitectureDocument } from "@archverse/architecture-model";

const privateProject: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  title: "Private",
  visibility: "private",
  document: emptyArchitectureDocument(),
  revision: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe("subscription entitlements", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  test("recognizes active and trialing Pro periods", () => {
    expect(
      hasActivePro(
        { plan: "pro", status: "active", currentPeriodEnd: null },
        now,
      ),
    ).toBe(true);
    expect(
      hasActivePro(
        {
          plan: "pro",
          status: "trialing",
          currentPeriodEnd: new Date("2026-02-01"),
        },
        now,
      ),
    ).toBe(true);
  });

  test("rejects expired, past-due, and free subscriptions", () => {
    expect(
      hasActivePro(
        {
          plan: "pro",
          status: "active",
          currentPeriodEnd: new Date("2025-12-31"),
        },
        now,
      ),
    ).toBe(false);
    expect(
      hasActivePro(
        { plan: "pro", status: "past_due", currentPeriodEnd: null },
        now,
      ),
    ).toBe(false);
    expect(
      hasActivePro(
        { plan: "free", status: "active", currentPeriodEnd: null },
        now,
      ),
    ).toBe(false);
  });

  test("allows free public writes but keeps expired private projects read-only", () => {
    expect(canWriteProject(null, "public", false)).toBe(true);
    expect(canWriteProject(null, "private", false)).toBe(false);
    expect(canWriteProject(privateProject, "private", false)).toBe(false);
    expect(canWriteProject(privateProject, "public", false)).toBe(false);
    expect(canWriteProject(privateProject, "private", true)).toBe(true);
  });
});
