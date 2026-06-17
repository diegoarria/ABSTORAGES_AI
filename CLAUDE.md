# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (auto-restart on change)
npm run dev          # nodemon backend/server.js  (full stack: PostgreSQL + Redis required)
node server-lite.js  # lightweight mode — no PostgreSQL/Redis needed, only ANTHROPIC_API_KEY

# Production
npm start            # node backend/server.js
```

`server-lite.js` is the primary development entrypoint. It runs fully without PostgreSQL or Redis and stores sessions/leads in-memory and on disk under `data/`.

## Architecture

### Two server modes

| File | Requires | Persistence |
|------|----------|-------------|
| `server-lite.js` | `ANTHROPIC_API_KEY` only | `data/sessions/*.json`, in-memory leads |
| `backend/server.js` | PostgreSQL + Redis | PostgreSQL DB, Redis pub/sub |

Both serve the same frontend from `frontend/` via Express static middleware after cookie-based auth.

### AI Agents

Each agent is a system prompt (`backend/agents/*.js`) + a route (`backend/routes/*.js`) that streams Claude responses via SSE.

- **SARA** — Sales AI. Qualifies leads, quotes freight, negotiates price, captures 13-field orders. Emits `NUEVA_ORDEN: {...}` in text when closing a sale; emits `CERRAR_CHAT` / `ESCALAR_HUMANO` as control signals.
- **SOFIA** — Operations AI. Receives the folio from SARA, looks it up in `ordersStore`, coordinates carriers via Vapi.ai phone calls.

Control signals (`CERRAR_CHAT`, `ESCALAR_HUMANO`, `NUEVA_ORDEN`) are plain text tokens that SARA/SOFIA write in their responses. The backend detects them with regex after streaming completes and emits typed SSE events (`cerrar_chat`, `escalar_humano`, `nueva_orden`) to the frontend.

### Chat flow (SSE streaming)

```
Frontend POST /api/sara/chat
  → backend builds systemPrompt = agentPrompt + tariff.getContext().prompt
  → chatStream() calls Anthropic SDK messages.stream()
  → chunks sent as SSE { type: 'chunk', text }
  → onDone: detect control signals → emit typed events
  → { type: 'done' }
```

`backend/services/claude.js` wraps the Anthropic SDK. Model is `claude-haiku-4-5-20251001`.

### Session / memory

- **`backend/services/sessionMemory.js`** — in-process Map, keyed `"AGENTE:sessionId"`. Used by both server modes. Holds up to 60 messages per session. Also stores `activeFolio` per session so SOFIA doesn't re-ask.
- **`backend/services/sessions.js`** — cookie session store backed by `data/sessions.json`. TTL 7 days.
- **`backend/services/memory.js`** — disk-based per-session JSON under `data/sessions/` (used by server-lite).

### Tariff engine

`backend/services/tariff.js` computes freight prices from real route distances + tolls + operating costs (diesel, tires, maintenance, driver, insurance). `tariff.getContext()` returns a formatted prompt block injected into SARA's system prompt so she always quotes real prices.

### SARA → SOFIA handoff

1. SARA emits `NUEVA_ORDEN: { folio, ...13 fields }` in her response text.
2. Backend parses it, calls `ordersStore.guardarOrden()` and publishes to Redis (`nueva_orden` channel).
3. Backend also fires `lanzarNegociacion()` which contacts all carriers in `data/proveedores.json` via Vapi.ai in parallel.
4. SOFIA looks up the folio in `ordersStore` to get all order details without asking the customer again.

### Auth

Cookie-based (`abs_session`). Users defined in `backend/data/users.json`. Sessions stored in `data/sessions.json`. Middleware at `backend/middleware/auth.js` protects all routes except `/login`, `/api/login`, `/api/logout`, `/webhook/whatsapp`.

## Environment variables

```
ANTHROPIC_API_KEY       # required always
PORT                    # default 3000
DATABASE_URL            # PostgreSQL (server.js only)
REDIS_URL               # Redis (server.js only)
ELEVENLABS_API_KEY      # optional TTS
WHATSAPP_API_KEY        # optional 360dialog WhatsApp
VAPI_API_KEY            # optional Vapi.ai carrier calls
PORTAL_USERNAME / PORTAL_PASSWORD  # legacy basic auth (unused in current flow)
```

## Key data flows to know

- **Leads** are captured by regex on SARA's full response text (`backend/services/leads.js`). They are in-memory only in server-lite; PostgreSQL in full server.
- **Carriers** (`data/proveedores.json`) are loaded once at startup. Empty array = WhatsApp negotiation silently skipped.
- **Redis** is used for pub/sub between SARA and SOFIA in full-server mode. In server-lite, SOFIA reads `ordersStore` directly.
- The frontend uses vanilla JS modules (`frontend/js/`). No build step — files are served as-is.
