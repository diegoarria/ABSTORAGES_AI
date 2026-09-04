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

## Siguiente paso

Fase 2 (Edge Functions → adaptadas a este stack como jobs de Node con
`node-cron`, ver más abajo cuando se construya) queda pendiente de tu
confirmación.
