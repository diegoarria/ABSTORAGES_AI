// ─── GPS MAP — Leaflet.js + unidades mock en carreteras mexicanas ─────────────

const GpsMap = (() => {
  let map = null;
  let markers = {};
  let animFrames = {};

  // Unidades mock en rutas reales de México
  const UNIDADES = [
    {
      id: 'ABST-000101',
      chofer: 'Juan Hernández',
      tipo: 'Caja seca 53\'',
      ruta: 'CDMX → Monterrey',
      estatus: 'EN_PROCESO',
      lat: 21.8818, lng: -99.8836,
      velocidad: 87,
      folio: 'ABST-000101',
      cliente: 'Distribuidora Norteña',
      kmRestantes: 398,
      citaHora: horaRelativa(4, 30),
    },
    {
      id: 'ABST-000098',
      chofer: 'Pedro Ríos',
      tipo: 'Torton',
      ruta: 'Guadalajara → CDMX',
      estatus: 'EN_PROCESO',
      lat: 20.6597, lng: -103.3496,
      velocidad: 72,
      folio: 'ABST-000098',
      cliente: 'Frutas del Norte',
      kmRestantes: 541,
      citaHora: horaRelativa(8, 0),
    },
    {
      id: 'ABST-000095',
      chofer: 'Carlos Mendez',
      tipo: 'Caja refrigerada',
      ruta: 'Monterrey → CDMX',
      estatus: 'PROGRAMADO',
      lat: 25.6866, lng: -100.3161,
      velocidad: 0,
      folio: 'ABST-000095',
      cliente: 'Lácteos del Norte',
      kmRestantes: 910,
      citaHora: horaRelativa(14, 0),
    },
    {
      id: 'ABST-000089',
      chofer: 'Miguel Torres',
      tipo: 'Caja seca 48\'',
      ruta: 'CDMX → Veracruz',
      estatus: 'EN_PROCESO',
      lat: 19.4326, lng: -96.8792,
      velocidad: 91,
      folio: 'ABST-000089',
      cliente: 'Abarrotes Central',
      kmRestantes: 48,
      citaHora: horaRelativa(1, 15),
    },
    {
      id: 'ABST-000077',
      chofer: 'Roberto Silva',
      tipo: 'Torton cama baja',
      ruta: 'CDMX → Querétaro',
      estatus: 'ALERTA',
      lat: 20.1011, lng: -99.7611,
      velocidad: 0,
      folio: 'ABST-000077',
      cliente: 'Grupo Industrial QRO',
      kmRestantes: 112,
      citaHora: horaRelativa(1, 45),
    },
    {
      id: 'ABST-000071',
      chofer: 'Ernesto Vega',
      tipo: 'Caja seca 53\'',
      ruta: 'Tijuana → Hermosillo',
      estatus: 'EN_PROCESO',
      lat: 30.8406, lng: -114.3538,
      velocidad: 95,
      folio: 'ABST-000071',
      cliente: 'Exportadora del Pacífico',
      kmRestantes: 503,
      citaHora: horaRelativa(6, 30),
    },
    {
      id: 'ABST-000065',
      chofer: 'Arturo Campos',
      tipo: 'Torton',
      ruta: 'Puebla → Oaxaca',
      estatus: 'ENTREGADO',
      lat: 17.0732, lng: -96.7266,
      velocidad: 0,
      folio: 'ABST-000065',
      cliente: 'Textiles Oaxaca',
      kmRestantes: 0,
      citaHora: horaRelativa(-2, -20), // ya entregado, hace 2h20
    },
  ];

  // Calcula una hora fija relativa a "ahora + offsetH horas + offsetMin min"
  function horaRelativa(offsetH, offsetMin) {
    const d = new Date(Date.now() + (offsetH * 60 + offsetMin) * 60000);
    return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  // Calcula ETA dinámica a partir de kmRestantes y velocidad actual
  function calcETA(u) {
    if (u.estatus === 'ENTREGADO') return '— Entregado';
    if (u.estatus === 'PROGRAMADO') return 'Pendiente de salida';
    if (u.kmRestantes <= 0) return 'Llegando';
    const velRef = u.velocidad > 10 ? u.velocidad : 75; // si está parado usa velocidad de referencia
    const msRestantes = (u.kmRestantes / velRef) * 3600000;
    const eta = new Date(Date.now() + msRestantes);
    return eta.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  // Margen entre ETA y cita: negativo = retrasado
  function margenCita(u) {
    if (u.estatus === 'ENTREGADO' || u.estatus === 'PROGRAMADO') return null;
    const velRef = u.velocidad > 10 ? u.velocidad : 75;
    const msETA = (u.kmRestantes / velRef) * 3600000;
    const etaMs = Date.now() + msETA;
    // Reconstruir cita como Date de hoy
    const [hh, mm] = u.citaHora.split(':').map(Number);
    const cita = new Date(); cita.setHours(hh, mm, 0, 0);
    const diffMin = Math.round((cita - etaMs) / 60000);
    return diffMin;
  }

  const STATUS_COLOR_DARK  = { EN_PROCESO:'#00e87a', PROGRAMADO:'#4a9eff', ALERTA:'#ff4a4a', ENTREGADO:'#7e8899' };
  const STATUS_COLOR_LIGHT = { EN_PROCESO:'#007a3d', PROGRAMADO:'#1a6bbf', ALERTA:'#b91c1c', ENTREGADO:'#374151' };

  function isLight() { return document.documentElement.getAttribute('data-theme') === 'light'; }
  function statusColor(estatus) {
    const map_ = isLight() ? STATUS_COLOR_LIGHT : STATUS_COLOR_DARK;
    return map_[estatus] || (isLight() ? '#374151' : '#7e8899');
  }

  let tileLayer = null;

  function getTileUrl() {
    return isLight()
      ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
  }

  function swapTileLayer() {
    if (!map) return;
    if (tileLayer) map.removeLayer(tileLayer);
    tileLayer = L.tileLayer(getTileUrl(), { maxZoom: 18 }).addTo(map);
    updateSidebar();
  }

  function init() {
    const el = document.getElementById('gps-map');
    if (!el || map) return;

    map = L.map('gps-map', {
      center: [23.0, -102.5],
      zoom: 5,
      zoomControl: true,
      attributionControl: false,
    });

    tileLayer = L.tileLayer(getTileUrl(), { maxZoom: 18 }).addTo(map);

    UNIDADES.forEach(u => addMarker(u));
    updateCounter();
    startAnimation();
  }

  function addMarker(u) {
    const color = statusColor(u.estatus);
    const isAlerta = u.estatus === 'ALERTA';

    const icon = L.divIcon({
      className: '',
      html: `
        <div class="gps-marker ${isAlerta ? 'gps-alerta' : ''}" style="border-color:${color}">
          <div class="gps-dot" style="background:${color}"></div>
          ${isAlerta ? '<div class="gps-pulse" style="background:'+color+'"></div>' : ''}
        </div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

    const marker = L.marker([u.lat, u.lng], { icon })
      .addTo(map)
      .bindPopup(buildPopup(u), { className: 'gps-popup', maxWidth: 260 });

    markers[u.id] = { marker, data: { ...u } };
  }

  function buildPopup(u) {
    const color  = statusColor(u.estatus);
    const vel    = u.velocidad > 0 ? `${u.velocidad} km/h` : 'Detenida';
    const eta    = calcETA(u);
    const margen = margenCita(u);

    // Bloque de ETA + cita
    let etaBlock = '';
    if (u.estatus === 'ENTREGADO') {
      etaBlock = `
        <div class="gps-popup-divider"></div>
        <div class="gps-popup-row gps-eta-row">
          <b>Cita</b>
          <span class="gps-eta-value gps-eta-ok">✓ Entregado ${u.citaHora}</span>
        </div>`;
    } else if (u.estatus === 'PROGRAMADO') {
      etaBlock = `
        <div class="gps-popup-divider"></div>
        <div class="gps-popup-row gps-eta-row">
          <b>Cita destino</b>
          <span class="gps-eta-value">${u.citaHora}</span>
        </div>
        <div class="gps-popup-row gps-eta-row">
          <b>Distancia</b>
          <span class="gps-eta-value">${u.kmRestantes} km</span>
        </div>`;
    } else {
      const margenTxt = margen === null ? ''
        : margen >= 0
          ? `<span class="gps-margen gps-margen-ok">+${margen} min de margen</span>`
          : `<span class="gps-margen gps-margen-late">${margen} min (retrasado)</span>`;
      etaBlock = `
        <div class="gps-popup-divider"></div>
        <div class="gps-popup-row gps-eta-row">
          <b>ETA llegada</b>
          <span class="gps-eta-value">${eta} <span class="gps-eta-km">(${u.kmRestantes} km)</span></span>
        </div>
        <div class="gps-popup-row gps-eta-row">
          <b>Cita cliente</b>
          <span class="gps-eta-value gps-cita">${u.citaHora} ${margenTxt}</span>
        </div>`;
    }

    return `
      <div class="gps-popup-inner">
        <div class="gps-popup-header">
          <span class="gps-folio">${u.folio}</span>
          <span class="gps-badge" style="color:${color};border-color:${color}20;background:${color}12">${u.estatus.replace('_',' ')}</span>
        </div>
        <div class="gps-popup-row"><b>Chofer</b>${u.chofer}</div>
        <div class="gps-popup-row"><b>Unidad</b>${u.tipo}</div>
        <div class="gps-popup-row"><b>Ruta</b>${u.ruta}</div>
        <div class="gps-popup-row"><b>Cliente</b>${u.cliente}</div>
        <div class="gps-popup-row"><b>Velocidad</b>${vel}</div>
        ${etaBlock}
      </div>`;
  }

  // Mover las unidades EN_PROCESO levemente para simular movimiento
  function startAnimation() {
    setInterval(() => {
      UNIDADES.forEach(u => {
        if (u.estatus !== 'EN_PROCESO') return;
        const m = markers[u.id];
        if (!m) return;

        // Desplazamiento aleatorio pequeño en dirección de la ruta
        u.lat += (Math.random() - 0.48) * 0.008;
        u.lng += (Math.random() - 0.45) * 0.012;
        m.marker.setLatLng([u.lat, u.lng]);

        // Velocidad fluctúa y km disminuyen
        u.velocidad = 75 + Math.floor(Math.random() * 25);
        u.kmRestantes = Math.max(0, u.kmRestantes - (u.velocidad * 3 / 3600)); // 3s de sim
        m.marker.setPopupContent(buildPopup(u));
      });
      updateSidebar();
    }, 3000);
  }

  function updateCounter() {
    const en_proceso = UNIDADES.filter(u => u.estatus === 'EN_PROCESO').length;
    const alertas    = UNIDADES.filter(u => u.estatus === 'ALERTA').length;
    const el = document.getElementById('gps-counter');
    if (el) el.innerHTML = `
      <span class="gps-stat green">${en_proceso} en ruta</span>
      ${alertas ? `<span class="gps-stat red">${alertas} alerta</span>` : ''}
      <span class="gps-stat muted">${UNIDADES.length} total</span>`;
  }

  function updateSidebar() {
    const list = document.getElementById('gps-list');
    if (!list) return;
    list.innerHTML = UNIDADES.map(u => {
      const color = statusColor(u.estatus);
      const vel   = u.velocidad > 0 ? `${u.velocidad} km/h` : 'Detenida';
      const eta   = u.estatus === 'EN_PROCESO' ? calcETA(u) : (u.estatus === 'ENTREGADO' ? '✓' : '—');
      const margen = margenCita(u);
      const margenCls = margen === null ? '' : margen >= 0 ? 'gps-eta-ok' : 'gps-eta-late';
      return `
        <div class="gps-list-row" onclick="GpsMap.focusUnit('${u.id}')">
          <div class="gps-list-dot" style="background:${color}"></div>
          <div class="gps-list-info">
            <div class="gps-list-folio">${u.folio}</div>
            <div class="gps-list-ruta">${u.ruta}</div>
            <div class="gps-list-eta ${margenCls}">
              ${u.estatus === 'EN_PROCESO' ? `ETA ${eta} · Cita ${u.citaHora}` : u.estatus === 'PROGRAMADO' ? `Cita ${u.citaHora}` : u.estatus === 'ENTREGADO' ? 'Entregado' : ''}
            </div>
          </div>
          <div class="gps-list-vel">${vel}</div>
        </div>`;
    }).join('');
  }

  function focusUnit(id) {
    const m = markers[id];
    if (!m) return;
    map.setView(m.marker.getLatLng(), 9, { animate: true });
    m.marker.openPopup();
  }

  // Init cuando el tab de dashboard esté visible
  function tryInit() {
    if (document.getElementById('gps-map')) {
      init();
      updateSidebar();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(tryInit, 300);
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.tab === 'dashboard') setTimeout(tryInit, 100);
      });
    });

    // Re-renderizar mapa y sidebar al cambiar tema
    new MutationObserver(() => swapTileLayer()).observe(
      document.documentElement,
      { attributes: true, attributeFilter: ['data-theme'] }
    );
  });

  return { focusUnit, init: tryInit, swapTileLayer };
})();
