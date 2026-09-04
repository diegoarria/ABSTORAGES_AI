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

## Fase 3 — panel de administración técnico

App separada, Vite + React + TypeScript (`monitoring/admin-panel/`), con su
**propio `package.json`** (no comparte dependencias con el resto del repo) y
su **propio login** (`monitoring/lib/adminAuth.js` — usuario/contraseña con
hash real vía `scrypt`, sesión propia por cookie `monitoring_session`; cero
relación con `backend/middleware/auth.js` ni `data/sessions.json` del negocio).

Adaptación respecto al plan original: pedías Supabase Auth restringido a un
rol `monitoring_admin` — como no hay Supabase, el equivalente real aquí es
que **la propia base de datos** solo le permite a la contraseña de Postgres
del rol `monitoring_admin` leer/escribir lo que le corresponde (RLS de la
Fase 1), y el panel además tiene su login independiente encima.

### Vistas
- **Dashboard** — estado actual de cada servicio + latencia promedio 24h.
- **Eventos de seguridad** — filtrable por severidad y tipo, con detalle JSON expandible.
- **Incidentes** — lista + botón para marcar como resuelto.
- **Historial de alertas** — qué se envió, cuándo, estado de entrega.

### Cómo correrlo en desarrollo

```bash
# 1. Crea tu usuario del panel (una sola vez)
npm run monitoring:create-admin -- diego "una-contraseña-fuerte-de-verdad"

# 2. Arranca el servidor del panel (API + auth)
npm run monitoring:panel        # puerto 4001 por defecto

# 3. En otra terminal, arranca el frontend con hot-reload
cd monitoring/admin-panel && npm install && npm run dev   # puerto 5175, proxya /api al 4001
```

### Despliegue

**Opción simple (recomendada, usa la infra que ya tienes en Railway):**
1. `cd monitoring/admin-panel && npm install && npm run build` — genera `dist/`.
2. Sube `monitoring/admin-server.js` como un servicio nuevo de Railway (o el
   mismo droplet, otro proceso) con su propio `monitoring/.env` — sirve el
   `dist/` ya compilado directo, sin necesitar Vercel/Netlify.
3. `npm run monitoring:panel` (o el equivalente `node monitoring/admin-server.js`
   como start command de ese servicio).

**Opción Vercel/Netlify (como pediste originalmente) — con un matiz:**
Vercel/Netlify sirven sitios estáticos; la API (`admin-server.js`) necesita un
proceso Node corriendo, así que en ese caso el frontend y la API quedan en
sitios distintos:
1. Despliega `admin-server.js` en Railway (o cualquier host con proceso
   persistente) — apunta `MONITORING_ADMIN_PORT` y el resto de variables ahí.
2. En Vercel: importa `monitoring/admin-panel/` como proyecto, con **Root
   Directory** = `monitoring/admin-panel`, build command `npm run build`,
   output directory `dist`.
3. Define `VITE_API_TARGET` en Vercel apuntando a la URL pública de tu
   `admin-server.js`, y ajusta `vite.config.ts`/`api.ts` para usar esa URL
   absoluta en producción (ahora mismo `api.ts` asume mismo origen — con
   dominios separados hay que resolver CORS en `admin-server.js` con
   `cors({ origin: TU_DOMINIO_VERCEL, credentials: true })`).

Dado que ya tienes todo en Railway, la opción simple es la que te ahorra
ese trabajo extra de CORS entre dominios.

## Fase 4 — verificación

Estos son los comandos para probar las 3 cosas que pediste, una vez que
tengas la base de monitoring levantada (Fase 1) — no los pude correr yo
mismo porque esa base todavía no existe en tu Railway, pero están listos
para copiar/pegar tal cual.

### 1. RLS realmente bloquea lo que no debe

```bash
# Como monitoring_admin: SELECT funciona
psql "$MONITORING_ADMIN_DATABASE_URL" -c "SELECT count(*) FROM incidents;"

# Como monitoring_admin: INSERT debe FALLAR (solo tiene SELECT + UPDATE acotado)
psql "$MONITORING_ADMIN_DATABASE_URL" -c "INSERT INTO service_checks (service_name, status) VALUES ('test','ok');"
# Esperado: ERROR: permission denied for table service_checks

# Como monitoring_admin: UPDATE de una columna NO concedida debe FALLAR
psql "$MONITORING_ADMIN_DATABASE_URL" -c "UPDATE incidents SET summary_text = 'hackeado' WHERE true;"
# Esperado: ERROR: permission denied for table incidents (o "column summary_text")

# Como monitoring_admin: UPDATE de resolved SÍ debe funcionar
psql "$MONITORING_ADMIN_DATABASE_URL" -c "UPDATE incidents SET resolved = true WHERE false;" # WHERE false = no toca filas reales, solo prueba el permiso

# Rol sin ningún grant — ni siquiera debe poder ver que las tablas existen
psql "$MONITORING_OWNER_DATABASE_URL" -c "
  CREATE ROLE rando_test WITH LOGIN PASSWORD 'temporal123';
"
psql "postgresql://rando_test:temporal123@<host>:5432/<db>" -c "SELECT * FROM incidents;"
# Esperado: ERROR: permission denied for table incidents
psql "$MONITORING_OWNER_DATABASE_URL" -c "DROP ROLE rando_test;" # limpiar
```

### 2. Los jobs corren sin errores antes de apuntar a APIs reales

Con `.env` configurado pero **sin** las API keys de los servicios (o con
keys inválidas a propósito), los checkers deben degradar a `status='down'`
o `'degraded'` sin tronar el proceso — nunca deben lanzar una excepción sin
capturar:

```bash
# Corre un solo ciclo de cada job y confirma que no hay errores no capturados
node -e "require('./monitoring/jobs/healthCheckCron').correrHealthChecks().then(() => console.log('health-check OK')).catch(e => { console.error('FALLÓ:', e); process.exit(1); })"

node -e "require('./monitoring/jobs/securityLogScanner').correrSecurityScan().then(() => console.log('security-scan OK')).catch(e => { console.error('FALLÓ:', e); process.exit(1); })"

node -e "require('./monitoring/jobs/incidentAnalyzer').analizar().then(() => console.log('analyzer OK')).catch(e => { console.error('FALLÓ:', e); process.exit(1); })"

# Confirma que sí quedaron filas, aunque los checks hayan sido 'down'
psql "$MONITORING_SERVICE_DATABASE_URL" -c "SELECT service_name, status, checked_at FROM service_checks ORDER BY checked_at DESC LIMIT 10;"
```

Una vez confirmado esto, pon las API keys reales en `monitoring/.env` y
corre `npm run monitoring` para el proceso completo y persistente.

### 3. El panel rechaza logins sin el rol correcto

```bash
# Arranca el panel (necesitas haber creado un usuario con monitoring:create-admin)
npm run monitoring:panel &

# Sin sesión — debe regresar 401
curl -i http://localhost:4001/api/dashboard
# Esperado: HTTP/1.1 401 Unauthorized

# Login con contraseña incorrecta — debe regresar 401
curl -i -X POST http://localhost:4001/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"diego","password":"contraseña-incorrecta"}'
# Esperado: HTTP/1.1 401 Unauthorized

# Login correcto — debe regresar 200 + set-cookie, y CON esa cookie /api/dashboard sí responde
curl -i -c cookies.txt -X POST http://localhost:4001/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"diego","password":"tu-contraseña-real"}'
curl -i -b cookies.txt http://localhost:4001/api/dashboard
# Esperado: HTTP/1.1 200 OK en ambos
```

### Lo que sí verifiqué yo mismo, sin necesitar la base todavía
- `npm install && npm run build` en `monitoring/admin-panel/` — compila
  TypeScript sin errores y genera `dist/` correctamente.
- Todos los archivos `.js` nuevos pasan `node -c` (sintaxis válida).
