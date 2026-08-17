import {
  ArchitectureDocumentSchema,
  type ArchitectureDocument,
} from "@archverse/architecture-model";
import { z } from "zod";

export const ProjectIdSchema = z.uuid();
export const VisibilitySchema = z.enum(["public", "private"]);
export type Visibility = z.infer<typeof VisibilitySchema>;

export type User = {
  id: string;
  githubId: string;
  githubLogin: string;
  avatarUrl: string | null;
};

export type Subscription = {
  plan: "free" | "pro";
  status: "inactive" | "active" | "trialing" | "past_due" | "canceled";
  currentPeriodEnd: Date | null;
};

export type Project = {
  id: string;
  ownerId: string;
  title: string;
  visibility: Visibility;
  document: ArchitectureDocument;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

export const ProjectCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  visibility: VisibilitySchema,
  document: ArchitectureDocumentSchema,
});

export const ProjectUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    visibility: VisibilitySchema.optional(),
    document: ArchitectureDocumentSchema.optional(),
    revision: z.number().int().positive(),
  })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.visibility !== undefined ||
      input.document !== undefined,
    "Provide at least one project change",
  );

export type ProjectCreate = z.infer<typeof ProjectCreateSchema>;
export type ProjectUpdate = z.infer<typeof ProjectUpdateSchema>;

export function hasActivePro(
  subscription: Subscription | null,
  now = new Date(),
): boolean {
  if (!subscription || subscription.plan !== "pro") return false;
  if (!new Set(["active", "trialing"]).has(subscription.status)) return false;
  return (
    subscription.currentPeriodEnd === null ||
    subscription.currentPeriodEnd > now
  );
}

export function canWriteProject(
  current: Project | null,
  nextVisibility: Visibility,
  activePro: boolean,
): boolean {
  if (current?.visibility === "private" && !activePro) return false;
  return nextVisibility === "public" || activePro;
}
