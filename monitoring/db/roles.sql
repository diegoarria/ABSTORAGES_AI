-- ─── ROLES — corre esto UNA SOLA VEZ, a mano, con las credenciales dueñas de
-- la base de datos dedicada de monitoring (el usuario que Railway te da al
-- crear el nuevo servicio de Postgres — NO el `postgres` de la base de
-- SARA/SOFIA/NOA). No lo ejecuta la app ni migrate.js — es intencional: crear
-- roles y contraseñas es un paso administrativo, no algo que el código deba
-- poder hacer solo.
--
-- Uso:
--   psql "$MONITORING_OWNER_DATABASE_URL" -f monitoring/db/roles.sql
--
-- Después de correrlo, guarda las 2 contraseñas que pongas abajo en tu gestor
-- de secretos — las vas a necesitar para MONITORING_SERVICE_DATABASE_URL y
-- MONITORING_ADMIN_DATABASE_URL en monitoring/.env.

-- Rol para las funciones del propio monitoreo (health-check-cron,
-- security-log-scanner, incident-analyzer) — puede escribir en las 4 tablas.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'monitoring_service') THEN
    CREATE ROLE monitoring_service WITH LOGIN PASSWORD 'CAMBIA_ESTA_CONTRASEÑA_1' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- Rol para el panel admin — solo lectura + puede marcar incidentes como
-- resueltos (UPDATE acotado a esa columna vía política RLS, no acceso total).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'monitoring_admin') THEN
    CREATE ROLE monitoring_admin WITH LOGIN PASSWORD 'CAMBIA_ESTA_CONTRASEÑA_2' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- pg_monitor: rol nativo de Postgres (desde v10), de solo lectura de
-- estadísticas del propio servidor — permite que security-log-scanner vea
-- pg_stat_activity (conexiones activas a la base de monitoring) sin darle
-- ningún acceso a datos de tablas más allá de las que ya se le otorgaron.
GRANT pg_monitor TO monitoring_service;

-- Nadie más (ni el rol por default `PUBLIC`) puede conectarse y ver nada,
-- ni siquiera con las tablas ya creadas — se refuerza otra vez en schema.sql
-- con RLS, esto es la primera capa (privilegios de esquema/tabla).
REVOKE ALL ON SCHEMA public FROM PUBLIC;
