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
      lat: 21.8818, lng: -99.8836, // Autopista 57, San Luis Potosí
      velocidad: 87,
      folio: 'ABST-000101',
      cliente: 'Distribuidora Norteña',
    },
    {
      id: 'ABST-000098',
      chofer: 'Pedro Ríos',
      tipo: 'Torton',
      ruta: 'Guadalajara → CDMX',
      estatus: 'EN_PROCESO',
      lat: 20.6597, lng: -103.3496, // Guadalajara
      velocidad: 72,
      folio: 'ABST-000098',
      cliente: 'Frutas del Norte',
    },
    {
      id: 'ABST-000095',
      chofer: 'Carlos Mendez',
      tipo: 'Caja refrigerada',
      ruta: 'Monterrey → CDMX',
      estatus: 'PROGRAMADO',
      lat: 25.6866, lng: -100.3161, // Monterrey
      velocidad: 0,
      folio: 'ABST-000095',
      cliente: 'Lácteos del Norte',
    },
    {
      id: 'ABST-000089',
      chofer: 'Miguel Torres',
      tipo: 'Caja seca 48\'',
      ruta: 'CDMX → Veracruz',
      estatus: 'EN_PROCESO',
      lat: 19.4326, lng: -96.8792, // Entre CDMX y Veracruz
      velocidad: 91,
      folio: 'ABST-000089',
      cliente: 'Abarrotes Central',
    },
    {
      id: 'ABST-000077',
      chofer: 'Roberto Silva',
      tipo: 'Torton cama baja',
      ruta: 'CDMX → Querétaro',
      estatus: 'ALERTA',
      lat: 20.1011, lng: -99.7611, // Tepeji del Río — detenida
      velocidad: 0,
      folio: 'ABST-000077',
      cliente: 'Grupo Industrial QRO',
    },
    {
      id: 'ABST-000071',
      chofer: 'Ernesto Vega',
      tipo: 'Caja seca 53\'',
      ruta: 'Tijuana → Hermosillo',
      estatus: 'EN_PROCESO',
      lat: 30.8406, lng: -114.3538, // Autopista Tijuana-Mexicali
      velocidad: 95,
      folio: 'ABST-000071',
      cliente: 'Exportadora del Pacífico',
    },
    {
      id: 'ABST-000065',
      chofer: 'Arturo Campos',
      tipo: 'Torton',
      ruta: 'Puebla → Oaxaca',
      estatus: 'ENTREGADO',
      lat: 17.0732, lng: -96.7266, // Oaxaca
      velocidad: 0,
      folio: 'ABST-000065',
      cliente: 'Textiles Oaxaca',
    },
  ];

  const STATUS_COLOR = {
    EN_PROCESO : '#00e87a',
    PROGRAMADO : '#4a9eff',
    ALERTA     : '#ff4a4a',
    ENTREGADO  : '#7e8899',
  };

  function init() {
    const el = document.getElementById('gps-map');
    if (!el || map) return;

    map = L.map('gps-map', {
      center: [23.0, -102.5],
      zoom: 5,
      zoomControl: true,
      attributionControl: false,
    });

    // Tile dark — CartoDB Dark Matter
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 18,
    }).addTo(map);

    UNIDADES.forEach(u => addMarker(u));
    updateCounter();
    startAnimation();
  }

  function addMarker(u) {
    const color = STATUS_COLOR[u.estatus] || '#7e8899';
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
    const color = STATUS_COLOR[u.estatus] || '#7e8899';
    const vel = u.velocidad > 0 ? `${u.velocidad} km/h` : 'Detenida';
    return `
      <div class="gps-popup-inner">
        <div class="gps-popup-header">
          <span class="gps-folio">${u.folio}</span>
          <span class="gps-badge" style="color:${color};border-color:${color}20;background:${color}12">${u.estatus}</span>
        </div>
        <div class="gps-popup-row"><b>Chofer</b>${u.chofer}</div>
        <div class="gps-popup-row"><b>Unidad</b>${u.tipo}</div>
        <div class="gps-popup-row"><b>Ruta</b>${u.ruta}</div>
        <div class="gps-popup-row"><b>Cliente</b>${u.cliente}</div>
        <div class="gps-popup-row"><b>Velocidad</b>${vel}</div>
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

        // Velocidad fluctúa
        u.velocidad = 75 + Math.floor(Math.random() * 25);
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
      const color = STATUS_COLOR[u.estatus] || '#7e8899';
      const vel = u.velocidad > 0 ? `${u.velocidad} km/h` : 'Detenida';
      return `
        <div class="gps-list-row" onclick="GpsMap.focusUnit('${u.id}')">
          <div class="gps-list-dot" style="background:${color}"></div>
          <div class="gps-list-info">
            <div class="gps-list-folio">${u.folio}</div>
            <div class="gps-list-ruta">${u.ruta}</div>
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
    // Re-intentar cuando el usuario cambie de tab al dashboard
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.tab === 'dashboard') setTimeout(tryInit, 100);
      });
    });
  });

  return { focusUnit, init: tryInit };
})();
