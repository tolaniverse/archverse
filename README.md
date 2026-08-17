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

| Variable                  | Required   | Purpose                                                                     |
| ------------------------- | ---------- | --------------------------------------------------------------------------- |
| `ARCHVERSE_ENABLE_OPENAI` | No         | Explicit opt-in; defaults to `false` to prevent accidental public API spend |
| `OPENAI_API_KEY`          | No         | Provider key used only when OpenAI is explicitly enabled                    |
| `OPENAI_MODEL`            | No         | Defaults to `gpt-4.1-mini`                                                  |
| `CORS_ORIGIN`             | Production | Exact browser origin allowed by the API                                     |
| `VITE_API_URL`            | Production | Public API origin compiled into the web bundle                              |
| `VITE_TLDRAW_LICENSE_KEY` | Production | tldraw production license key for the deployed domain                       |

`VITE_*` values are build-time variables. Rebuild the web image after changing them.

## Commands

```bash
pnpm dev          # run web and server watchers
pnpm test         # reducer, schema, planner, and route tests
pnpm typecheck    # strict TypeScript across the workspace
pnpm build        # production bundles
```

## API

### `GET /health`

Returns server readiness information.

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
3. Set `VITE_API_URL` to the public HTTPS API domain.
4. Set `CORS_ORIGIN` to the public HTTPS web domain.
5. Add `VITE_TLDRAW_LICENSE_KEY`, then rebuild.

OpenAI is intentionally disabled by default. Do not enable it on a public deployment until authentication, durable rate limiting, and provider-side spend caps are configured. The deterministic planner remains available without it.

There is no database in this slice because project data is currently browser-local. Adding an unused PostgreSQL container would create operational work without persistence value.

## Current boundaries

Not included yet:

- Authentication, server-side projects, or cross-device persistence
- Multiplayer sync, comments, presence, or version history
- PNG/SVG export; the current tldraw image-export API needs a deliberate UX and asset policy
- Full two-way domain synchronization for arbitrary manually-created tldraw shapes
- Infrastructure generation or deployment execution
- Horizontal sync-room scaling

Production tldraw use requires an appropriate license key. Review the current tldraw license terms before deploying publicly.
