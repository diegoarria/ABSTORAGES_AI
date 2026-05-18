-- ABSTORAGES AI Portal — PostgreSQL Schema
-- Versión 1.0

-- ─── EXTENSION ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── CLIENTES ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clientes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  razon_social VARCHAR(255) NOT NULL,
  nombre_comercial VARCHAR(255),
  rfc VARCHAR(20),
  contacto_comercial_nombre VARCHAR(255),
  contacto_comercial_tel VARCHAR(20),
  contacto_comercial_email VARCHAR(255),
  contacto_operativo_nombre VARCHAR(255),
  contacto_operativo_tel VARCHAR(20),
  contacto_operativo_email VARCHAR(255),
  contacto_facturacion_nombre VARCHAR(255),
  contacto_facturacion_tel VARCHAR(20),
  contacto_facturacion_email VARCHAR(255),
  politica_pago TEXT,
  acepta_acuse_electronico BOOLEAN DEFAULT FALSE,
  normas_instalaciones TEXT,
  rutas_recurrentes TEXT[],
  tipo_mercancia TEXT,
  estatus VARCHAR(50) DEFAULT 'ACTIVO', -- ACTIVO, INACTIVO, PROSPECTO
  credito_autorizado BOOLEAN DEFAULT FALSE,
  notas TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── PROSPECTOS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prospectos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre VARCHAR(255) NOT NULL,
  empresa VARCHAR(255),
  tel VARCHAR(20),
  email VARCHAR(255),
  ruta_interes TEXT,
  tipo_unidad VARCHAR(100),
  volumen_mensual VARCHAR(100),
  tarifa_objetivo NUMERIC(12, 2),
  estatus VARCHAR(50) DEFAULT 'NUEVO', -- NUEVO, EN_SEGUIMIENTO, NEGOCIACION, CERRADO, INACTIVO
  ultimo_contacto TIMESTAMPTZ,
  siguiente_accion TEXT,
  notas TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── PROVEEDORES (TRANSPORTISTAS) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proveedores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  razon_social VARCHAR(255) NOT NULL,
  nombre_contacto VARCHAR(255),
  tel_contacto VARCHAR(20),
  email_contacto VARCHAR(255),
  rfc VARCHAR(20),
  clabe VARCHAR(20),
  banco VARCHAR(100),
  clasificacion VARCHAR(50) DEFAULT 'POTENCIAL', -- RECURRENTE, INTERMITENTE, POTENCIAL
  viajes_completados INTEGER DEFAULT 0,
  rutas_operadas TEXT[],
  tipos_unidad TEXT[],
  gps_proveedor VARCHAR(255),
  gps_usuario VARCHAR(255),
  gps_password VARCHAR(255),
  abcontrol_certificado BOOLEAN DEFAULT FALSE,
  abcontrol_fecha_cert DATE,
  estatus VARCHAR(50) DEFAULT 'ACTIVO', -- ACTIVO, INACTIVO, SUSPENDIDO
  notas TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── UNIDADES (VEHICULOS) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS unidades (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  proveedor_id UUID REFERENCES proveedores(id),
  tipo VARCHAR(100) NOT NULL, -- TORTON, RABON, CAJA_SECA_48, CAJA_SECA_53, PLATAFORMA, REFRIGERADA
  placas_tracto VARCHAR(20),
  placas_remolque VARCHAR(20),
  modelo_tracto VARCHAR(100),
  anio_tracto INTEGER,
  niv VARCHAR(50),
  seguro_vigencia DATE,
  circulacion_vigencia DATE,
  permiso_ruta_vigencia DATE,
  fumigacion_vigencia DATE,
  gps_activo BOOLEAN DEFAULT FALSE,
  estatus VARCHAR(50) DEFAULT 'DISPONIBLE', -- DISPONIBLE, EN_SERVICIO, MANTENIMIENTO, BAJA
  notas TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── TARIFARIO ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tarifario (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  origen VARCHAR(255) NOT NULL,
  destino VARCHAR(255) NOT NULL,
  cp_origen VARCHAR(10),
  cp_destino VARCHAR(10),
  tipo_unidad VARCHAR(100) NOT NULL,
  tarifa_base NUMERIC(12, 2) NOT NULL,
  tarifa_cliente_min NUMERIC(12, 2),
  tiempo_estimado_horas INTEGER,
  notas TEXT,
  vigente BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── FOLIOS (SERVICIOS) ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS folios (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  folio VARCHAR(50) UNIQUE NOT NULL, -- ABST-XXXXXX
  cliente_id UUID REFERENCES clientes(id),
  proveedor_id UUID REFERENCES proveedores(id),
  unidad_id UUID REFERENCES unidades(id),
  origen VARCHAR(255) NOT NULL,
  destino VARCHAR(255) NOT NULL,
  cp_origen VARCHAR(10),
  cp_destino VARCHAR(10),
  tipo_unidad VARCHAR(100),
  mercancia TEXT,
  peso NUMERIC(10, 2),
  fecha_carga DATE,
  hora_cita TIME,
  precio_cliente NUMERIC(12, 2),
  precio_transportista NUMERIC(12, 2),
  margen_porcentaje NUMERIC(5, 2),
  anticipo_monto NUMERIC(12, 2),
  anticipo_enviado BOOLEAN DEFAULT FALSE,
  anticipo_fecha TIMESTAMPTZ,
  pago_final_monto NUMERIC(12, 2),
  pago_final_enviado BOOLEAN DEFAULT FALSE,
  pago_final_fecha TIMESTAMPTZ,
  estatus VARCHAR(50) DEFAULT 'PENDIENTE', -- PENDIENTE, EN_BUSQUEDA, PROGRAMADO, EN_PROCESO, ENTREGADO, CONCLUIDO
  estatus_anterior VARCHAR(50),
  acuse_digital_url TEXT,
  acuse_fisico_recibido BOOLEAN DEFAULT FALSE,
  acuse_fisico_fecha TIMESTAMPTZ,
  condiciones_especiales TEXT,
  numero_sello VARCHAR(100),
  notas TEXT,
  created_by VARCHAR(50) DEFAULT 'SARA',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── DOCUMENTOS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documentos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  folio_id UUID REFERENCES folios(id),
  proveedor_id UUID REFERENCES proveedores(id),
  tipo VARCHAR(100) NOT NULL, -- ACUSE, GPS_FOTO, CARGA_FOTO, EXTERIOR_FOTO, CHECKLIST_MECANICO, FUMIGACION, NORMAS_FIRMADAS
  url TEXT NOT NULL,
  descripcion TEXT,
  subido_por VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── CONVERSACIONES (HISTORIAL DE CHAT) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversaciones (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agente VARCHAR(10) NOT NULL, -- SARA, SOFIA
  session_id VARCHAR(255),
  role VARCHAR(20) NOT NULL, -- user, assistant
  content TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── ACTIVIDAD LOG (PARA SSE) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS actividad_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agente VARCHAR(10), -- SARA, SOFIA, SISTEMA
  tipo VARCHAR(50), -- INFO, ALERTA, ERROR, ESCALADO, FOLIO_ACTUALIZADO
  folio VARCHAR(50),
  mensaje TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── ALERTAS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alertas (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  folio_id UUID REFERENCES folios(id),
  tipo VARCHAR(100) NOT NULL, -- GPS_SIN_SEÑAL, CHOFER_NO_RESPONDE, UNIDAD_DETENIDA, ROBO_SINIESTRO
  descripcion TEXT,
  nivel VARCHAR(20) DEFAULT 'MEDIA', -- BAJA, MEDIA, ALTA, CRITICA
  resuelta BOOLEAN DEFAULT FALSE,
  resuelta_por VARCHAR(100),
  resuelta_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── INDICES ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_folios_estatus ON folios(estatus);
CREATE INDEX IF NOT EXISTS idx_folios_cliente ON folios(cliente_id);
CREATE INDEX IF NOT EXISTS idx_folios_proveedor ON folios(proveedor_id);
CREATE INDEX IF NOT EXISTS idx_folios_folio ON folios(folio);
CREATE INDEX IF NOT EXISTS idx_conversaciones_agente ON conversaciones(agente);
CREATE INDEX IF NOT EXISTS idx_conversaciones_session ON conversaciones(session_id);
CREATE INDEX IF NOT EXISTS idx_actividad_log_created ON actividad_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alertas_resuelta ON alertas(resuelta);
CREATE INDEX IF NOT EXISTS idx_proveedores_clasificacion ON proveedores(clasificacion);

-- ─── FUNCIÓN UPDATED_AT ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── TRIGGERS ────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['clientes','prospectos','proveedores','unidades','tarifario','folios']
  LOOP
    EXECUTE format('
      CREATE TRIGGER trg_updated_at_%s
      BEFORE UPDATE ON %s
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    ', t, t);
  END LOOP;
END;
$$ LANGUAGE plpgsql;
