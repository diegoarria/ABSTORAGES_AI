# ABSTORAGES AI Portal

Portal operativo con dos agentes IA conectados para ABSTORAGES Logistics Solutions.

- **SARA** — AI Vendedora: prospecta, cotiza, negocia y cierra contratos 24/7
- **SOFIA** — AI Planner: opera servicios, monitorea viajes, gestiona proveedores y folios 24/7

Comunicación entre agentes vía **Redis Pub/Sub** (`nueva_orden` + `unidades_disponibles`).

---

## Stack

| Capa | Tecnología |
|------|------------|
| Backend | Node.js + Express |
| IA | Anthropic SDK (`claude-sonnet-4-6`) |
| Base de datos | PostgreSQL |
| Mensajería | Redis Pub/Sub (ioredis) |
| Frontend | Vanilla HTML/CSS/JS |
| WhatsApp | 360dialog WhatsApp Business API |
| Voz | Vapi.ai |

---

## Setup

### 1. Dependencias

```bash
npm install
```

### 2. Variables de entorno

```bash
cp .env.example .env
```

Editar `.env` con tus credenciales:

```env
ANTHROPIC_API_KEY=sk-ant-...
PORTAL_USERNAME=admin
PORTAL_PASSWORD=tu_password_seguro
DATABASE_URL=postgresql://user:pass@localhost:5432/abstorages_portal
REDIS_URL=redis://localhost:6379
WHATSAPP_API_KEY=...   # 360dialog
VAPI_API_KEY=...
```

### 3. Base de datos

```bash
# Crear la base de datos
createdb abstorages_portal

# Aplicar esquema
psql abstorages_portal < backend/db/schema.sql
```

### 4. Redis

```bash
# macOS
brew install redis && brew services start redis

# Docker
docker run -d -p 6379:6379 redis:alpine
```

### 5. Iniciar

```bash
# Producción
npm start

# Desarrollo (hot reload)
npm run dev
```

Portal disponible en: **http://localhost:3000**

---

## Arquitectura

```
┌─────────────────────────────────────────────────┐
│                  ABSTORAGES Portal               │
│          (Vanilla HTML + Express + Auth)         │
└──────────────┬──────────────────┬────────────────┘
               │                  │
    ┌──────────▼──────┐  ┌────────▼──────────┐
    │      SARA       │  │      SOFIA        │
    │  AI Vendedora   │  │   AI Planner      │
    │  /api/sara/chat │  │  /api/sofia/chat  │
    └──────────┬──────┘  └────────┬──────────┘
               │   Redis Pub/Sub  │
               │  nueva_orden ──► │
               │  ◄── unidades_disponibles
               │                  │
    ┌──────────▼──────────────────▼──────────┐
    │           Claude API (Streaming)       │
    │         claude-sonnet-4-6              │
    └────────────────────────────────────────┘
               │
    ┌──────────▼──────────────────────────────┐
    │              PostgreSQL                 │
    │  clientes · proveedores · folios        │
    │  tarifario · documentos · alertas       │
    └─────────────────────────────────────────┘
```

---

## Flujo Sara → Sofia

1. SARA cierra venta en el chat
2. SARA publica evento `nueva_orden` en Redis con datos del servicio
3. SOFIA recibe el evento y **ejecuta el flujo de colocación** automáticamente:
   - Busca proveedores disponibles para la ruta
   - Contacta por WhatsApp (360dialog)
   - Negocia condiciones (margen mínimo 20%)
   - Coordina anticipo, documentación ABCONTROL, GPS
   - Monitorea el viaje cada 2 horas
   - Gestiona el cierre y pago final

---

## Estatus de Folios

```
PENDIENTE → EN_BUSQUEDA → PROGRAMADO → EN_PROCESO → ENTREGADO → CONCLUIDO
```

---

## Endpoints API

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/health` | Estado del servidor |
| GET | `/api/metricas` | Métricas del dashboard |
| POST | `/api/sara/chat` | Chat con SARA (SSE streaming) |
| POST | `/api/sara/nueva-orden` | Publicar orden manualmente |
| GET | `/api/sara/historial/:sessionId` | Historial de conversación |
| POST | `/api/sofia/chat` | Chat con SOFIA (SSE streaming) |
| GET | `/api/sofia/folios` | Folios activos |
| PATCH | `/api/sofia/folios/:id/estatus` | Actualizar estatus de folio |
| GET | `/api/sofia/metricas` | Métricas operativas |
| GET | `/api/actividad/stream` | SSE — actividad en tiempo real |

Todos los endpoints requieren **Basic Auth** (configurado en `.env`).

---

## Integración WhatsApp (360dialog)

Configurar `WHATSAPP_API_KEY` en `.env`. Sin clave configurada, el sistema funciona en modo **STUB** (log en consola).

## Integración Voz (Vapi.ai)

Configurar `VAPI_API_KEY`, `VAPI_PHONE_ID`, `VAPI_ASSISTANT_ID` en `.env`. Sin clave, opera en modo **STUB**.

---

*ABSTORAGES Logistics Solutions · Portal v1.0*
