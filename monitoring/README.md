# Monitoring — sistema técnico 24/7, aislado de SARA/SOFIA/NOA

No es un agente de negocio, no interactúa con clientes. Vive en su propia
carpeta (`monitoring/`) y en su propia base de datos Postgres — **completamente
separada** de la base que usa el resto del repo (`backend/db/schema.sql`).

## Por qué una base de datos separada y no solo un esquema

El backend de negocio (`server.js` / `server-lite.js`) se conecta a Postgres
con el rol `postgres` (superusuario de Railway). En Postgres, **RLS nunca
aplica a un superusuario** — así que un esquema `monitoring` con RLS dentro de
esa misma base no habría sido aislamiento real, solo una barrera que el propio
backend de negocio podría saltarse sin querer. Por eso esto corre en un
**servicio de Postgres distinto**, con credenciales que el código de negocio
nunca ve ni usa.

## Fase 1 — cómo aplicar el esquema

1. En Railway (o donde prefieras), crea un **nuevo servicio de Postgres**
   dedicado solo a esto. Copia su connection string.
2. `cp monitoring/.env.example monitoring/.env` y pon esa connection string
   en `MONITORING_OWNER_DATABASE_URL`.
3. Edita `monitoring/db/roles.sql` y cambia las 2 contraseñas placeholder por
   contraseñas reales fuertes.
4. Corre **una sola vez**, con las credenciales dueñas de la base:
   ```bash
   psql "$MONITORING_OWNER_DATABASE_URL" -f monitoring/db/roles.sql
   ```
5. Copia las 2 contraseñas que pusiste en el paso 3 a
   `MONITORING_SERVICE_DATABASE_URL` y `MONITORING_ADMIN_DATABASE_URL` en tu
   `monitoring/.env` (mismo host, mismo puerto, solo cambia usuario/contraseña).
6. Aplica las tablas y las políticas RLS:
   ```bash
   node monitoring/db/migrate.js
   ```

Después de esto existen 4 tablas (`service_checks`, `security_events`,
`incidents`, `alert_log`) con RLS real: solo `monitoring_service` y
`monitoring_admin` pueden leer/escribir, cada uno con el alcance que le
corresponde (ver comentarios en `schema.sql`).

## Fase 2 — los 3 jobs

Adaptados de "Edge Functions de Supabase + pg_cron" a un proceso de Node
independiente (`monitoring/index.js`) que agenda los 3 jobs con
`setInterval` — no hay Deno ni pg_cron en este stack, y así tampoco depende
de que la base tenga extensiones especiales.

- `jobs/healthCheckCron.js` — cada 5 min, pinga Claude, Vapi, ElevenLabs,
  Twilio (el WhatsApp real de este proyecto — no 360dialog) y Cliengo
  (best-effort, sin auth: este proyecto no tiene integración de API con
  Cliengo). 2 fallas consecutivas de un servicio → `security_events`.
- `jobs/securityLogScanner.js` — cada 10 min. Reinterpretado respecto al
  plan original (que asumía `auth.audit_log_entries` de Supabase, que no
  existe aquí): vigila (a) 401/403/429 repetidos contra los servicios
  monitoreados, y (b) conexiones inesperadas a la propia base de
  `monitoring` vía `pg_stat_activity` — cualquier rol que no sea
  `monitoring_service`/`monitoring_admin` conectado ahí es una señal real
  de credenciales filtradas.
- `jobs/incidentAnalyzer.js` — cada 15 min, o al instante si algo
  high/critical lo dispara. Junta las señales de la ventana, le pide a
  Claude clasificar severidad + redactar resumen en JSON, guarda en
  `incidents`, y si es high/critical manda WhatsApp (Twilio) + registra en
  `alert_log`.

### Cómo correrlo

```bash
npm run monitoring:migrate   # solo la primera vez (o tras cambiar schema.sql)
npm run monitoring           # arranca el proceso, corre indefinidamente
```

Este proceso **nunca se importa desde `server-lite.js` ni `backend/server.js`**
— en producción va como un servicio de Railway aparte (o cualquier proceso
independiente), con su propio `.env`.

## Siguiente paso

Fase 3 (panel de administración técnico) queda pendiente de tu confirmación.
