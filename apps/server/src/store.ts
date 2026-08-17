import { SQL } from "bun";
import {
  ArchitectureDocumentSchema,
  type ArchitectureDocument,
} from "@archverse/architecture-model";
import type {
  Project,
  ProjectCreate,
  ProjectUpdate,
  Subscription,
  User,
} from "./domain";

export interface Store {
  ping(): Promise<void>;
  upsertGithubUser(input: {
    githubId: string;
    githubLogin: string;
    avatarUrl: string | null;
  }): Promise<User>;
  createSession(input: {
    tokenHash: string;
    userId: string;
    expiresAt: Date;
  }): Promise<void>;
  getUserBySessionHash(tokenHash: string, now: Date): Promise<User | null>;
  deleteSession(tokenHash: string): Promise<void>;
  getSubscription(userId: string): Promise<Subscription | null>;
  createProject(ownerId: string, input: ProjectCreate): Promise<Project>;
  listProjects(ownerId: string): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  updateProject(
    id: string,
    ownerId: string,
    input: ProjectUpdate,
  ): Promise<Project | "conflict" | null>;
  deleteProject(
    id: string,
    ownerId: string,
    revision: number,
  ): Promise<"deleted" | "conflict" | null>;
}

type Row = Record<string, unknown>;

function userFromRow(row: Row): User {
  return {
    id: String(row.id),
    githubId: String(row.github_id),
    githubLogin: String(row.github_login),
    avatarUrl: row.avatar_url === null ? null : String(row.avatar_url),
  };
}

function projectFromRow(row: Row): Project {
  const rawDocument =
    typeof row.document === "string" ? JSON.parse(row.document) : row.document;
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    title: String(row.title),
    visibility: row.visibility === "private" ? "private" : "public",
    document: ArchitectureDocumentSchema.parse(rawDocument),
    revision: Number(row.revision),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

export class PostgresStore implements Store {
  readonly sql: SQL;

  constructor(databaseUrl: string) {
    this.sql = new SQL(databaseUrl);
  }

  async ping(): Promise<void> {
    await this.sql`SELECT 1`;
  }

  async upsertGithubUser(input: {
    githubId: string;
    githubLogin: string;
    avatarUrl: string | null;
  }): Promise<User> {
    const id = crypto.randomUUID();
    const rows = await this.sql`
      INSERT INTO users (id, github_id, github_login, avatar_url)
      VALUES (${id}, ${input.githubId}, ${input.githubLogin}, ${input.avatarUrl})
      ON CONFLICT (github_id) DO UPDATE SET
        github_login = EXCLUDED.github_login,
        avatar_url = EXCLUDED.avatar_url,
        updated_at = now()
      RETURNING *
    `;
    return userFromRow(rows[0] as Row);
  }

  async createSession(input: {
    tokenHash: string;
    userId: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.sql`
      INSERT INTO sessions (token_hash, user_id, expires_at)
      VALUES (${input.tokenHash}, ${input.userId}, ${input.expiresAt})
    `;
  }

  async getUserBySessionHash(
    tokenHash: string,
    now: Date,
  ): Promise<User | null> {
    const rows = await this.sql`
      SELECT u.* FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ${tokenHash} AND s.expires_at > ${now}
      LIMIT 1
    `;
    return rows[0] ? userFromRow(rows[0] as Row) : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
  }

  async getSubscription(userId: string): Promise<Subscription | null> {
    const rows = await this.sql`
      SELECT plan, status, current_period_end
      FROM subscriptions WHERE user_id = ${userId} LIMIT 1
    `;
    const row = rows[0] as Row | undefined;
    if (!row) return null;
    return {
      plan: row.plan === "pro" ? "pro" : "free",
      status: row.status as Subscription["status"],
      currentPeriodEnd: row.current_period_end
        ? new Date(String(row.current_period_end))
        : null,
    };
  }

  async createProject(ownerId: string, input: ProjectCreate): Promise<Project> {
    const id = crypto.randomUUID();
    const document = JSON.stringify(input.document);
    const rows = await this.sql`
      INSERT INTO projects (id, owner_id, title, visibility, document)
      VALUES (${id}, ${ownerId}, ${input.title}, ${input.visibility}, ${document}::jsonb)
      RETURNING *
    `;
    return projectFromRow(rows[0] as Row);
  }

  async listProjects(ownerId: string): Promise<Project[]> {
    const rows = await this.sql`
      SELECT * FROM projects WHERE owner_id = ${ownerId} ORDER BY updated_at DESC
    `;
    return rows.map((row: Row) => projectFromRow(row));
  }

  async getProject(id: string): Promise<Project | null> {
    const rows = await this
      .sql`SELECT * FROM projects WHERE id = ${id} LIMIT 1`;
    return rows[0] ? projectFromRow(rows[0] as Row) : null;
  }

  async updateProject(
    id: string,
    ownerId: string,
    input: ProjectUpdate,
  ): Promise<Project | "conflict" | null> {
    const current = await this.getProject(id);
    if (!current || current.ownerId !== ownerId) return null;
    const title = input.title ?? current.title;
    const visibility = input.visibility ?? current.visibility;
    const document: ArchitectureDocument = input.document ?? current.document;
    const documentJson = JSON.stringify(document);
    const rows = await this.sql`
      UPDATE projects SET
        title = ${title}, visibility = ${visibility}, document = ${documentJson}::jsonb,
        revision = revision + 1, updated_at = now()
      WHERE id = ${id} AND owner_id = ${ownerId} AND revision = ${input.revision}
      RETURNING *
    `;
    if (rows[0]) return projectFromRow(rows[0] as Row);
    const stillExists = await this.getProject(id);
    return stillExists?.ownerId === ownerId ? "conflict" : null;
  }

  async deleteProject(
    id: string,
    ownerId: string,
    revision: number,
  ): Promise<"deleted" | "conflict" | null> {
    const rows = await this.sql`
      WITH owned AS (
        SELECT revision FROM projects WHERE id = ${id} AND owner_id = ${ownerId}
      ), deleted AS (
        DELETE FROM projects
        WHERE id = ${id} AND owner_id = ${ownerId} AND revision = ${revision}
        RETURNING id
      )
      SELECT CASE
        WHEN EXISTS (SELECT 1 FROM deleted) THEN 'deleted'
        WHEN EXISTS (SELECT 1 FROM owned) THEN 'conflict'
        ELSE 'missing'
      END AS outcome
    `;
    const outcome = String((rows[0] as Row).outcome);
    return outcome === "deleted"
      ? "deleted"
      : outcome === "conflict"
        ? "conflict"
        : null;
  }
}
