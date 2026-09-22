-- ─── MONITORING — esquema completo, en su propia base de datos dedicada ─────
-- Esta base de datos NO es la misma que usa SARA/SOFIA/NOA (backend/db/schema.sql).
-- Aislamiento real: host y credenciales completamente distintos, no solo un
-- esquema separado dentro de la misma base — así ningún bug ni cambio futuro
-- en el código de negocio puede tocar esto por accidente, y viceversa.
--
-- Requiere haber corrido roles.sql primero (crea monitoring_service y
-- monitoring_admin). Aplícalo con: node monitoring/db/migrate.js

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- para gen_random_uuid()

-- ─── SERVICE_CHECKS — resultado de cada health check ─────────────────────────
CREATE TABLE IF NOT EXISTS service_checks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name  TEXT NOT NULL, -- 'claude', 'vapi', 'elevenlabs', 'whatsapp' (Twilio), 'cliengo'
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status        TEXT NOT NULL CHECK (status IN ('ok', 'degraded', 'down')),
  latency_ms    INTEGER,
  status_code   INTEGER,
  raw_response  JSONB
);
CREATE INDEX IF NOT EXISTS idx_service_checks_service_time ON service_checks (service_name, checked_at DESC);

-- ─── SECURITY_EVENTS — eventos de seguridad detectados ───────────────────────
CREATE TABLE IF NOT EXISTS security_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type   TEXT NOT NULL CHECK (event_type IN ('failed_login', 'unusual_access', 'rls_violation', 'rate_limit_spike', 'other')),
  severity     TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  source_ip    TEXT,
  details      JSONB
);
CREATE INDEX IF NOT EXISTS idx_security_events_time ON security_events (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events (severity);

-- ─── INCIDENTS — resúmenes generados por el agente analizador ────────────────
CREATE TABLE IF NOT EXISTS incidents (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  severity           TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  summary_text       TEXT NOT NULL,
  related_event_ids  UUID[] DEFAULT '{}',
  resolved           BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_incidents_resolved ON incidents (resolved, created_at DESC);

-- ─── AGENT_CONTROL — fuente de verdad de qué IA está pausada ─────────────────
-- Antes esto vivía en un JSON en el disco del negocio (data/agent-pause.json)
-- — encontramos en vivo (22-sep-2026) que un volumen persistente de Railway
-- montado en /app/data tapaba cualquier valor que se subiera por git, así
-- que una pausa "committeada" nunca llegaba a tomar efecto en el servidor
-- real sin que nadie se enterara. Mover el estado aquí — base separada, con
-- su propio panel de administración — da un solo lugar verificable para
-- saber si un agente está pausado, en vez de confiar en el disco efímero de
-- otro servicio.
CREATE TABLE IF NOT EXISTS agent_control (
  agente      TEXT PRIMARY KEY CHECK (agente IN ('sara', 'sofia', 'noa')),
  paused      BOOLEAN NOT NULL DEFAULT FALSE,
  motivo      TEXT,
  changed_by  TEXT,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO agent_control (agente, paused) VALUES ('sara', FALSE), ('sofia', FALSE), ('noa', FALSE)
  ON CONFLICT (agente) DO NOTHING;

-- ─── OUTBOUND_CONTACT_LOG — cada llamada/plantilla real que sale ─────────────
-- Reportado por el negocio vía /internal/report-event (mismo secreto
-- compartido que security_events) cada vez que SARA/SOFIA/NOA de verdad
-- contactan a alguien (no cuando se omite por pausa/límite). Permite que
-- monitoring detecte solo, sin depender de que alguien pregunte, un volumen
-- de envíos fuera de lo normal — exactamente lo que hubiera cachado el
-- incidente del 16-22 de septiembre desde el primer día.
CREATE TABLE IF NOT EXISTS outbound_contact_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  agente      TEXT NOT NULL CHECK (agente IN ('sara', 'sofia', 'noa')),
  canal       TEXT NOT NULL, -- 'whatsapp_plantilla' | 'llamada'
  destinatario TEXT,         -- teléfono, guardado para poder contar destinatarios únicos
  detalle     JSONB
);
CREATE INDEX IF NOT EXISTS idx_outbound_contact_log_time ON outbound_contact_log (agente, sent_at DESC);

-- ─── ALERT_LOG — registro de alertas enviadas ────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id      UUID REFERENCES incidents(id),
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  channel          TEXT NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  delivery_status  TEXT NOT NULL DEFAULT 'pending' -- 'pending' | 'sent' | 'failed'
);

-- ─── RLS ──────────────────────────────────────────────────────────────────────
-- En esta base dedicada, ni monitoring_service ni monitoring_admin son
-- superusuario (ver roles.sql), así que RLS sí aplica de verdad sobre ambos —
-- a diferencia del caso de la base de negocio, donde el rol de la app es
-- superusuario y podría saltárselo.
ALTER TABLE service_checks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents            ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_control        ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_contact_log ENABLE ROW LEVEL SECURITY;

-- Sin esto, ningún GRANT sobre las tablas sirve de nada — un rol necesita
-- USAGE sobre el esquema mismo para poder siquiera "ver" que las tablas
-- existen (roles.sql hace REVOKE ALL ON SCHEMA public FROM PUBLIC, así que
-- hay que devolvérselo explícitamente a los 2 roles que sí deben entrar).
GRANT USAGE ON SCHEMA public TO monitoring_service, monitoring_admin;

-- monitoring_service: acceso total a las 6 tablas (así opera el cron/analyzer,
-- y así el negocio puede leer/escribir agent_control vía admin-server con el
-- secreto compartido, sin tener credenciales de esta base directamente).
GRANT SELECT, INSERT, UPDATE ON service_checks, security_events, incidents, alert_log, agent_control, outbound_contact_log TO monitoring_service;
DROP POLICY IF EXISTS service_full_access ON service_checks;
DROP POLICY IF EXISTS service_full_access ON security_events;
DROP POLICY IF EXISTS service_full_access ON incidents;
DROP POLICY IF EXISTS service_full_access ON alert_log;
DROP POLICY IF EXISTS service_full_access ON agent_control;
DROP POLICY IF EXISTS service_full_access ON outbound_contact_log;
CREATE POLICY service_full_access ON service_checks  FOR ALL TO monitoring_service USING (true) WITH CHECK (true);
CREATE POLICY service_full_access ON security_events FOR ALL TO monitoring_service USING (true) WITH CHECK (true);
CREATE POLICY service_full_access ON incidents       FOR ALL TO monitoring_service USING (true) WITH CHECK (true);
CREATE POLICY service_full_access ON alert_log        FOR ALL TO monitoring_service USING (true) WITH CHECK (true);
CREATE POLICY service_full_access ON agent_control        FOR ALL TO monitoring_service USING (true) WITH CHECK (true);
CREATE POLICY service_full_access ON outbound_contact_log FOR ALL TO monitoring_service USING (true) WITH CHECK (true);

-- monitoring_admin: lectura completa, pero en `incidents` solo puede
-- actualizar resolved/resolved_at. En `agent_control` SÍ puede escribir
-- completo — pausar/reanudar un agente desde el panel es justo la acción de
-- control que este rol existe para hacer.
GRANT SELECT ON service_checks, security_events, incidents, alert_log, agent_control, outbound_contact_log TO monitoring_admin;
GRANT UPDATE (resolved, resolved_at) ON incidents TO monitoring_admin;
GRANT UPDATE (paused, motivo, changed_by, changed_at) ON agent_control TO monitoring_admin;
DROP POLICY IF EXISTS admin_read ON service_checks;
DROP POLICY IF EXISTS admin_read ON security_events;
DROP POLICY IF EXISTS admin_read ON incidents;
DROP POLICY IF EXISTS admin_read ON alert_log;
DROP POLICY IF EXISTS admin_read ON agent_control;
DROP POLICY IF EXISTS admin_read ON outbound_contact_log;
DROP POLICY IF EXISTS admin_resolve ON incidents;
DROP POLICY IF EXISTS admin_write ON agent_control;
CREATE POLICY admin_read ON service_checks  FOR SELECT TO monitoring_admin USING (true);
CREATE POLICY admin_read ON security_events FOR SELECT TO monitoring_admin USING (true);
CREATE POLICY admin_read ON incidents       FOR SELECT TO monitoring_admin USING (true);
CREATE POLICY admin_read ON alert_log        FOR SELECT TO monitoring_admin USING (true);
CREATE POLICY admin_read ON agent_control        FOR SELECT TO monitoring_admin USING (true);
CREATE POLICY admin_read ON outbound_contact_log FOR SELECT TO monitoring_admin USING (true);
CREATE POLICY admin_resolve ON incidents FOR UPDATE TO monitoring_admin USING (true) WITH CHECK (true);
CREATE POLICY admin_write ON agent_control FOR UPDATE TO monitoring_admin USING (true) WITH CHECK (true);

-- Sin política = sin acceso para cualquier otro rol (incluido PUBLIC, y
-- cualquier rol futuro que se cree en esta base sin mencionarlo aquí).
