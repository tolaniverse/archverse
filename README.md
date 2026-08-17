# Archverse

Archverse is an AI-assisted architecture workbench. Describe a system, receive validated diagram commands, and continue editing the result as normal tldraw shapes.

This repository contains the first MVP vertical slice. It is intentionally single-user and local-first.

## What works

- Prompt → schema-validated architecture commands → editable tldraw nodes and bound arrows
- Follow-up additions plus selected-node rename and removal in deterministic demo mode
- OpenAI structured generation when a key and explicit enable flag are configured
- Prompt-derived demo planner when no AI key is present
- Browser autosave for the tldraw document and architecture domain model
- JSON and Markdown architecture exports
- Responsive Cobalt workbench UI with loading and actionable error states
- Bun/Elysia health and planning endpoints

## Stack

- pnpm workspaces and Turborepo
- React, Vite, TypeScript, and tldraw
- Bun and Elysia
- Zod domain and transport schemas
- Vercel AI SDK with the OpenAI provider
- Docker Compose for local or Dokploy deployment

## Repository map

```text
apps/
├── web/                         React/Vite canvas and planner UI
└── server/                      Elysia API and planning implementations
packages/
└── architecture-model/         Framework-independent schemas and reducer
deploy/
├── Dockerfile.server
└── Dockerfile.web
```

The server emits `DiagramCommand[]`. The architecture package validates and applies those commands deterministically. The web adapter maps stable domain IDs to tldraw shape IDs and stores the domain IDs in shape metadata. Arrow bindings keep connections attached when shapes move.

## Local development

Requirements:

- Bun 1.2+
- Node.js 22+
- pnpm 9.12+

```bash
pnpm install
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
pnpm dev
```

Open `http://localhost:5173`. The API runs on `http://localhost:3000`. The deterministic planner works immediately. OpenAI requires both a key and the explicit `ARCHVERSE_ENABLE_OPENAI=true` opt-in.

### Environment variables

| Variable                  | Required    | Purpose                                                                     |
| ------------------------- | ----------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`            | Persistence | PostgreSQL URL; the Compose hostname is `postgres`                          |
| `APP_URL`                 | Auth        | Exact public API origin, without a trailing slash                           |
| `WEB_URL`                 | Auth        | Exact public web origin used for redirects, CORS, and Origin checks         |
| `GITHUB_CLIENT_ID`        | Auth        | GitHub OAuth app client ID                                                  |
| `GITHUB_CLIENT_SECRET`    | Auth        | GitHub OAuth app secret                                                     |
| `ARCHVERSE_ENABLE_OPENAI` | No          | Explicit opt-in; OpenAI mode also requires an authenticated active-Pro user |
| `OPENAI_API_KEY`          | No          | Provider key used only when OpenAI is explicitly enabled                    |
| `OPENAI_MODEL`            | No          | Defaults to `gpt-4.1-mini`                                                  |
| `VITE_API_URL`            | Production  | Public API origin compiled into the web bundle                              |
| `VITE_TLDRAW_LICENSE_KEY` | Production  | tldraw production license key for the deployed domain                       |

`VITE_*` values are build-time variables. Rebuild the web image after changing them.

## Commands

```bash
pnpm dev          # run web and server watchers
pnpm test         # reducer, schema, planner, and route tests
pnpm typecheck    # strict TypeScript across the workspace
pnpm build        # production bundles
```

## API

### Health endpoints

- `GET /health` is process liveness and does not query PostgreSQL.
- `GET /ready` checks persistence with `SELECT 1` and returns `503` when unavailable. The server container healthcheck uses this endpoint.

### `POST /api/plan`

```json
{
  "prompt": "A user-facing API with Postgres and a queue",
  "document": {
    "version": 1,
    "title": "Untitled architecture",
    "nodes": [],
    "edges": []
  },
  "selectedNodeIds": []
}
```

The response includes `source`, a summary, and validated `commands`. Requests and responses are validated with shared Zod schemas. Semantic reducer validation rejects duplicate IDs and dangling connections.

### Authentication and projects

- `GET /api/auth/github` starts GitHub OAuth with state and S256 PKCE.
- `GET /api/auth/me` returns the current user and Pro entitlement.
- `POST /api/auth/logout` revokes the opaque database session.
- `GET|POST /api/projects` lists or creates the authenticated user's projects.
- `GET|PATCH /api/projects/:id` reads or changes a project using optimistic `revision` checks.
- `DELETE /api/projects/:id?revision=<positive-integer>` atomically deletes only the expected revision and returns `409` on conflict.

Private projects deliberately return `404` to non-owners. Public project reads are anonymous. Project responses omit internal owner IDs and sensitive JSON responses use `Cache-Control: no-store`. Cookie-authenticated unsafe requests require an exact `Origin` matching `WEB_URL`. Production requires HTTPS `APP_URL` and uses Secure, Path-scoped `__Host-` cookies.

## Docker and Dokploy

Run both containers locally:

```bash
cp .env.example .env
docker compose up --build
```

- Web: `http://localhost:4173`
- API: `http://localhost:3050`

For Dokploy:

1. Create a Compose service from this repository.
2. Assign public domains to web port `80` and server port `3000`.
3. Set `APP_URL=https://api.example.com`, `WEB_URL=https://app.example.com`, and `VITE_API_URL=https://api.example.com` (no trailing slashes).
4. Create a GitHub OAuth app with callback URL `https://api.example.com/api/auth/github/callback`.
5. Set a unique `POSTGRES_PASSWORD` and `DATABASE_URL=postgres://archverse:<URL-ENCODED-PASSWORD>@postgres:5432/archverse`, then add the GitHub and tldraw variables from `.env.example`.

The internal PostgreSQL service does not publish a host port. Before the API starts, the one-shot `migrate` service takes a PostgreSQL advisory lock and applies each checked-in SQL migration exactly once. Migration names are recorded in `schema_migrations`; a failure prevents the server from starting.

GitHub OAuth and project persistence are backend-only in this phase; the current web UI still uses browser-local storage. Public cloud projects are available to authenticated users through the API. Creating or modifying private projects requires an active Pro entitlement in `subscriptions`. An expired private project remains owner-readable and deletable but is otherwise read-only and is never made public automatically.

OpenAI is intentionally disabled by default. Keep it disabled on a public deployment until durable rate limiting and provider-side spend caps are configured. When enabled, the API requires an authenticated active-Pro user. The deterministic planner remains available anonymously while OpenAI is disabled.

## Current boundaries

Not included yet:

- Frontend login, cloud project, subscription checkout, or billing webhook UI
- Payment-provider integration; Pro entitlements are provider-neutral database records
- Multiplayer sync, comments, presence, or version history
- PNG/SVG export; the current tldraw image-export API needs a deliberate UX and asset policy
- Full two-way domain synchronization for arbitrary manually-created tldraw shapes
- Infrastructure generation or deployment execution
- Horizontal sync-room scaling

Production tldraw use requires an appropriate license key. Review the current tldraw license terms before deploying publicly.
