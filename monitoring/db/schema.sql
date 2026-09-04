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
ALTER TABLE service_checks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents       ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_log       ENABLE ROW LEVEL SECURITY;

-- Sin esto, ningún GRANT sobre las tablas sirve de nada — un rol necesita
-- USAGE sobre el esquema mismo para poder siquiera "ver" que las tablas
-- existen (roles.sql hace REVOKE ALL ON SCHEMA public FROM PUBLIC, así que
-- hay que devolvérselo explícitamente a los 2 roles que sí deben entrar).
GRANT USAGE ON SCHEMA public TO monitoring_service, monitoring_admin;

-- monitoring_service: acceso total a las 4 tablas (así opera el cron/analyzer).
GRANT SELECT, INSERT, UPDATE ON service_checks, security_events, incidents, alert_log TO monitoring_service;
DROP POLICY IF EXISTS service_full_access ON service_checks;
DROP POLICY IF EXISTS service_full_access ON security_events;
DROP POLICY IF EXISTS service_full_access ON incidents;
DROP POLICY IF EXISTS service_full_access ON alert_log;
CREATE POLICY service_full_access ON service_checks  FOR ALL TO monitoring_service USING (true) WITH CHECK (true);
CREATE POLICY service_full_access ON security_events FOR ALL TO monitoring_service USING (true) WITH CHECK (true);
CREATE POLICY service_full_access ON incidents       FOR ALL TO monitoring_service USING (true) WITH CHECK (true);
CREATE POLICY service_full_access ON alert_log        FOR ALL TO monitoring_service USING (true) WITH CHECK (true);

-- monitoring_admin: lectura completa de las 4 tablas, pero en `incidents`
-- solo puede actualizar resolved/resolved_at — no reescribir el resto de
-- columnas ni tocar filas ajenas a su rol.
GRANT SELECT ON service_checks, security_events, incidents, alert_log TO monitoring_admin;
GRANT UPDATE (resolved, resolved_at) ON incidents TO monitoring_admin;
DROP POLICY IF EXISTS admin_read ON service_checks;
DROP POLICY IF EXISTS admin_read ON security_events;
DROP POLICY IF EXISTS admin_read ON incidents;
DROP POLICY IF EXISTS admin_read ON alert_log;
DROP POLICY IF EXISTS admin_resolve ON incidents;
CREATE POLICY admin_read ON service_checks  FOR SELECT TO monitoring_admin USING (true);
CREATE POLICY admin_read ON security_events FOR SELECT TO monitoring_admin USING (true);
CREATE POLICY admin_read ON incidents       FOR SELECT TO monitoring_admin USING (true);
CREATE POLICY admin_read ON alert_log        FOR SELECT TO monitoring_admin USING (true);
CREATE POLICY admin_resolve ON incidents FOR UPDATE TO monitoring_admin USING (true) WITH CHECK (true);

-- Sin política = sin acceso para cualquier otro rol (incluido PUBLIC, y
-- cualquier rol futuro que se cree en esta base sin mencionarlo aquí).
