// ─── KPI DETAIL — Pantalla de detalle para SARA y SOFIA ──────────────────────

const KpiDetail = (() => {

  // ── DATOS MOCK ──────────────────────────────────────────────────────────────

  const SARA_CLIENTES = [
    {
      nombre: 'Carlos Mendoza',
      empresa: 'Distribuidora Norteña SA',
      estatus: 'Cerrado',
      ruta: 'CDMX → Monterrey',
      monto: '$38,500',
      ultimo_contacto: 'Hace 2 días',
      resumen: 'Cliente cerrado en el primer contacto. Ruta CDMX-MTY con 2 viajes semanales en caja seca 53\'. Firmó contrato a 30 días. Alta de cliente completada.',
      siguiente: 'Coordinar primer servicio con SOFIA',
      initials: 'CM',
    },
    {
      nombre: 'Rafael Torres',
      empresa: 'Bonafont / Danone México',
      estatus: 'Cerrado',
      ruta: 'Monterrey → CDMX',
      monto: '$42,000',
      ultimo_contacto: 'Hace 5 días',
      resumen: 'Segundo contrato del mes con Bonafont. Lograron bajar el precio anterior un 4% a cambio de comprometer 3 viajes semanales. Pago a 45 días acordado.',
      siguiente: 'Seguimiento semanal activo',
      initials: 'RT',
    },
    {
      nombre: 'Maria García',
      empresa: 'Lácteos del Norte',
      estatus: 'En negociación',
      ruta: 'Monterrey → Guadalajara',
      monto: '$28,000',
      ultimo_contacto: 'Ayer',
      resumen: 'Interesados pero comparan con dos proveedores más. Principal objeción: precio. Se les presentó propuesta de valor con GPS y cuenta espejo. Esperando respuesta antes del viernes.',
      siguiente: 'Llamada de seguimiento el viernes',
      initials: 'MG',
    },
    {
      nombre: 'Luis Garza',
      empresa: 'Frutas del Norte',
      estatus: 'En negociación',
      ruta: 'Monterrey → CDMX',
      monto: '$31,500',
      ultimo_contacto: 'Hace 3 días',
      resumen: 'Negociación avanzada. Cliente tiene urgencia para el jueves próximo. Pidió descuento del 8% que está fuera del margen. Escalado a humano para aprobación.',
      siguiente: 'Esperar respuesta de aprobación interna',
      initials: 'LG',
    },
    {
      nombre: 'Pedro Martínez',
      empresa: 'Alimentos del Norte SA',
      estatus: 'Cotización enviada',
      ruta: 'MTY → Guadalajara',
      monto: '$26,000',
      ultimo_contacto: 'Hace 1 día',
      resumen: 'Primer contacto el lunes. Requieren caja refrigerada para alimentos frescos. Se envió cotización con desglose completo. Sin respuesta aún.',
      siguiente: 'WhatsApp de seguimiento mañana si no responde',
      initials: 'PM',
    },
    {
      nombre: 'Alejandro Zapata',
      empresa: 'Marca Genérica MX',
      estatus: 'Cotización enviada',
      ruta: 'MTY → CDMX',
      monto: '$19,500',
      ultimo_contacto: 'Hace 4 días',
      resumen: 'Lead entrante por WhatsApp. Cotización de torton enviada. No ha leído los mensajes. Programado seguimiento por llamada el día 5.',
      siguiente: 'Llamada Vapi el día 5 sin respuesta',
      initials: 'AZ',
    },
    {
      nombre: 'Alex Ramírez',
      empresa: 'Vortex Agents',
      estatus: 'Nuevo contacto',
      ruta: 'MTY → Guadalajara',
      monto: 'Por cotizar',
      ultimo_contacto: 'Hoy',
      resumen: 'Contacto nuevo a través de grupo de WhatsApp. Preguntó por disponibilidad de torton en ruta MTY-GDL para la próxima semana. Pendiente levantar datos completos.',
      siguiente: 'Completar calificación y enviar cotización hoy',
      initials: 'AR',
    },
    {
      nombre: 'Daniel Vega',
      empresa: 'Vortex Agents (operaciones)',
      estatus: 'Nuevo contacto',
      ruta: 'MTY → CDMX',
      monto: 'Por cotizar',
      ultimo_contacto: 'Hoy',
      resumen: 'Referido de Alex Ramírez. Necesita caja seca 53\' para el lunes. Sin datos completos aún.',
      siguiente: 'Llamada de calificación hoy',
      initials: 'DV',
    },
  ];

  const SOFIA_SERVICIOS = [
    {
      folio: 'ABST-000101',
      cliente: 'Distribuidora Norteña',
      transportista: 'Juan Hernández / Fletes JH',
      ruta: 'CDMX → Monterrey',
      estatus: 'En proceso',
      unidad: 'Caja seca 53\'',
      ultimo_contacto: 'Hace 1h 20min',
      resumen: 'Viaje en curso. Última ubicación: Autopista 57, a la altura de San Luis Potosí. Velocidad: 87 km/h. Sin novedades. Próximo check en 40 minutos.',
      siguiente: 'Check de ruta a las 3:45 PM',
      initials: 'DN',
    },
    {
      folio: 'ABST-000098',
      cliente: 'Frutas del Norte',
      transportista: 'Pedro Ríos / Transportes PR',
      ruta: 'Guadalajara → CDMX',
      estatus: 'En proceso',
      unidad: 'Torton',
      ultimo_contacto: 'Hace 2h',
      resumen: 'Viaje en curso desde las 7 AM. Carga de frutas frescas con certificado de fumigación activo. Sello verificado al salir. Última ubicación: Autopista Guadalajara-CDMX km 180.',
      siguiente: 'Check de ruta en 1 hora',
      initials: 'FN',
    },
    {
      folio: 'ABST-000077',
      cliente: 'Grupo Industrial QRO',
      transportista: 'Roberto Silva',
      ruta: 'CDMX → Querétaro',
      estatus: '⚠️ Alerta',
      unidad: 'Torton cama baja',
      ultimo_contacto: 'Hace 42min — sin respuesta',
      resumen: 'ALERTA ACTIVA. Unidad detenida 42 minutos en Tepeji del Río (km 73, Autopista 57D). Chofer no responde WhatsApp ni llamada. Escalado a humano. Coordinando protocolo de verificación.',
      siguiente: 'Esperar respuesta de monitoreo humano',
      initials: 'GQ',
    },
    {
      folio: 'ABST-000095',
      cliente: 'Lácteos del Norte',
      transportista: 'Carlos Mendez / Refrigerados CM',
      ruta: 'Monterrey → CDMX',
      estatus: 'Programado',
      unidad: 'Caja refrigerada',
      ultimo_contacto: 'Hace 3h',
      resumen: 'Viaje programado para mañana 6:00 AM. Anticipo enviado: $14,000. Documentos ABCONTROL validados. Checklist mecánico confirmado. Transportista confirmó asistencia.',
      siguiente: 'Confirmar presencia a las 5:30 AM mañana',
      initials: 'LN',
    },
    {
      folio: 'ABST-000089',
      cliente: 'Abarrotes Central',
      transportista: 'Miguel Torres / MT Logística',
      ruta: 'CDMX → Veracruz',
      estatus: 'En proceso',
      unidad: 'Caja seca 48\'',
      ultimo_contacto: 'Hace 50min',
      resumen: 'Viaje en curso. Carga de abarrotes secos. Sin incidencias. A 3 horas aproximadas del destino en Veracruz. Cliente confirmó cita en CEDIS para las 6 PM.',
      siguiente: 'Solicitar foto de acuse al entregar',
      initials: 'AC',
    },
    {
      folio: 'ABST-000065',
      cliente: 'Textiles Oaxaca',
      transportista: 'Arturo Campos',
      ruta: 'Puebla → Oaxaca',
      estatus: 'Entregado',
      unidad: 'Torton',
      ultimo_contacto: 'Hace 4h',
      resumen: 'Entrega confirmada. Acuse digital recibido. Pendiente acuse físico original. Transportista confirmó envío por paquetería hoy.',
      siguiente: 'Recibir acuse físico y liberar pago final',
      initials: 'TO',
    },
    {
      folio: 'ABST-000083',
      cliente: 'Exportadora del Pacífico',
      transportista: 'Ernesto Vega / Fletes Noreste',
      ruta: 'Tijuana → Hermosillo',
      estatus: 'En proceso',
      unidad: 'Caja seca 53\'',
      ultimo_contacto: 'Hace 1h 45min',
      resumen: 'Viaje en curso. Carga de maquinaria de exportación. Velocidad promedio 95 km/h. Sin novedades. Cliente solicitó actualización cada 4 horas.',
      siguiente: 'Check de ruta a las 5 PM',
      initials: 'EP',
    },
  ];

  // ── CONFIGURACIÓN POR AGENTE ────────────────────────────────────────────────

  function isLight() {
    return document.documentElement.getAttribute('data-theme') === 'light';
  }

  const CONFIG = {
    sara: {
      name    : 'SARA',
      sub     : 'Detalle comercial · Clientes y prospectos',
      color   : 'green',
      get accent() { return isLight() ? '#007a3d' : '#00e87a'; },
      get dim()    { return isLight() ? 'rgba(0,122,61,.1)' : 'rgba(0,232,122,.12)'; },
      filters : ['Todos','Cerrado','En negociación','Cotización enviada','Nuevo contacto'],
      data    : SARA_CLIENTES,
      keyEstatus: 'estatus',
    },
    sofia: {
      name    : 'SOFIA',
      sub     : 'Detalle operativo · Servicios activos',
      color   : 'blue',
      get accent() { return isLight() ? '#1a6bbf' : '#4a9eff'; },
      get dim()    { return isLight() ? 'rgba(26,107,191,.1)' : 'rgba(74,158,255,.12)'; },
      filters : ['Todos','En proceso','⚠️ Alerta','Programado','Entregado'],
      data    : SOFIA_SERVICIOS,
      keyEstatus: 'estatus',
    },
  };

  let currentAgent  = null;
  let currentFilter = 'Todos';

  // ── OPEN / CLOSE ────────────────────────────────────────────────────────────

  function open(agent) {
    currentAgent  = agent;
    currentFilter = 'Todos';
    const cfg = CONFIG[agent];

    // Avatar
    const av = document.getElementById('kd-avatar');
    av.className = `kpi-agent-avatar ${agent}`;
    av.textContent = cfg.name[0];

    document.getElementById('kd-name').textContent = cfg.name;
    document.getElementById('kd-sub').textContent  = cfg.sub;

    // Header accent
    document.getElementById('kd-header').style.borderBottom = `1px solid ${cfg.accent}22`;

    // Filtros
    renderFilters(cfg);

    // Tarjetas
    renderCards(cfg, 'Todos');

    // Mostrar overlay
    document.getElementById('kpi-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    document.getElementById('kpi-overlay').classList.remove('open');
    document.body.style.overflow = '';
  }

  // ── FILTROS ─────────────────────────────────────────────────────────────────

  function renderFilters(cfg) {
    const el = document.getElementById('kd-filters');
    el.innerHTML = cfg.filters.map(f => `
      <button
        class="kd-filter-btn ${f === 'Todos' ? 'active ' + cfg.color : ''}"
        onclick="KpiDetail.filter('${f}')"
        data-filter="${f}">
        ${f}
        <span style="opacity:.5;font-size:10px;margin-left:4px">(${f === 'Todos' ? cfg.data.length : cfg.data.filter(d => d[cfg.keyEstatus] === f).length})</span>
      </button>`).join('');
  }

  function filter(f) {
    currentFilter = f;
    const cfg = CONFIG[currentAgent];

    // Actualizar botones activos
    document.querySelectorAll('.kd-filter-btn').forEach(btn => {
      const isActive = btn.dataset.filter === f;
      btn.className = `kd-filter-btn${isActive ? ' active ' + cfg.color : ''}`;
    });

    renderCards(cfg, f);
  }

  // ── TARJETAS ─────────────────────────────────────────────────────────────────

  function renderCards(cfg, filterVal) {
    const data = filterVal === 'Todos'
      ? cfg.data
      : cfg.data.filter(d => d[cfg.keyEstatus] === filterVal);

    const body = document.getElementById('kd-body');

    if (!data.length) {
      body.innerHTML = `<div class="kd-empty">No hay registros para este filtro.</div>`;
      return;
    }

    body.innerHTML = data.map(d => buildCard(d, cfg)).join('');
  }

  function buildCard(d, cfg) {
    const isAlerta = d.estatus.includes('⚠️');
    const accent   = isAlerta ? '#ff4a4a' : cfg.accent;
    const dim      = isAlerta ? 'rgba(255,74,74,.12)' : cfg.dim;

    // Badge color por estatus — adaptado al tema
    const light = isLight();
    const badgeColors = {
      'Cerrado'            : { color: light ? '#007a3d' : '#00e87a', bg: light ? 'rgba(0,122,61,.1)'    : 'rgba(0,232,122,.1)' },
      'En negociación'     : { color: light ? '#b45309' : '#f5a623', bg: light ? 'rgba(180,83,9,.1)'   : 'rgba(245,166,35,.1)' },
      'Cotización enviada' : { color: light ? '#1a6bbf' : '#4a9eff', bg: light ? 'rgba(26,107,191,.1)' : 'rgba(74,158,255,.1)' },
      'Nuevo contacto'     : { color: light ? '#374151' : '#7e8899', bg: light ? 'rgba(55,65,81,.08)'  : 'rgba(126,136,153,.1)' },
      'En proceso'         : { color: light ? '#007a3d' : '#00e87a', bg: light ? 'rgba(0,122,61,.1)'   : 'rgba(0,232,122,.1)' },
      'Programado'         : { color: light ? '#1a6bbf' : '#4a9eff', bg: light ? 'rgba(26,107,191,.1)' : 'rgba(74,158,255,.1)' },
      'Entregado'          : { color: light ? '#1a6bbf' : '#4a9eff', bg: light ? 'rgba(26,107,191,.1)' : 'rgba(74,158,255,.1)' },
      '⚠️ Alerta'          : { color: light ? '#b91c1c' : '#ff4a4a', bg: light ? 'rgba(185,28,28,.1)'  : 'rgba(255,74,74,.1)' },
    };
    const bc = badgeColors[d.estatus] || { color: light ? '#374151' : '#7e8899', bg: light ? 'rgba(55,65,81,.08)' : 'rgba(126,136,153,.1)' };

    // Campos de meta (diferentes para SARA vs SOFIA)
    const metaFields = cfg.name === 'SARA'
      ? `<div class="kd-meta-item"><div class="kd-meta-label">Empresa</div><div class="kd-meta-val">${d.empresa}</div></div>
         <div class="kd-meta-item"><div class="kd-meta-label">Ruta</div><div class="kd-meta-val">${d.ruta}</div></div>
         <div class="kd-meta-item"><div class="kd-meta-label">Monto</div><div class="kd-meta-val" style="color:var(--verde);font-weight:700">${d.monto}</div></div>`
      : `<div class="kd-meta-item"><div class="kd-meta-label">Folio</div><div class="kd-meta-val" style="font-family:var(--mono);color:var(--azul)">${d.folio}</div></div>
         <div class="kd-meta-item"><div class="kd-meta-label">Ruta</div><div class="kd-meta-val">${d.ruta}</div></div>
         <div class="kd-meta-item"><div class="kd-meta-label">Transportista</div><div class="kd-meta-val">${d.transportista}</div></div>
         <div class="kd-meta-item"><div class="kd-meta-label">Unidad</div><div class="kd-meta-val">${d.unidad}</div></div>`;

    const titleName = cfg.name === 'SARA' ? d.nombre : d.cliente;

    return `
      <div class="kd-card">
        <div class="kd-card-top">
          <div class="kd-card-avatar" style="background:${dim};color:${accent}">${d.initials}</div>
          <div class="kd-card-info">
            <div class="kd-card-name">${titleName}</div>
            <div class="kd-card-empresa">${cfg.name === 'SARA' ? d.empresa : d.ruta}</div>
          </div>
          <div class="kd-card-badge" style="color:${bc.color};background:${bc.bg};border-color:${bc.color}30">
            ${d.estatus}
          </div>
        </div>
        <div class="kd-card-meta">${metaFields}</div>
        <div class="kd-card-resumen" style="border-color:${accent}">${d.resumen}</div>
        <div class="kd-card-footer">
          <div class="kd-next-action">Siguiente: <span>${d.siguiente}</span></div>
          <div class="kd-date">Último contacto: ${d.ultimo_contacto}</div>
        </div>
      </div>`;
  }

  // ── CERRAR CON ESC o click fuera ─────────────────────────────────────────────

  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  document.getElementById('kpi-overlay')?.addEventListener('click', e => {
    if (e.target.id === 'kpi-overlay') close();
  });

  return { open, close, filter };
})();
