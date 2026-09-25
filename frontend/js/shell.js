// Barra de aplicación corporativa compartida + tema claro/oscuro.
// Un solo <script src="/js/shell.js"> en el <head> de cada página:
//  1) aplica el tema guardado ANTES de pintar (sin parpadeo)
//  2) al cargar el DOM, inserta la barra de navegación al inicio del body
(function () {
  var KEY = 'abs-theme';
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  root.setAttribute('data-theme', saved === 'dark' ? 'dark' : 'light');

  var LINKS = [
    ['/', 'Portal'], ['/actividad.html', 'En vivo'], ['/colocaciones.html', 'Colocaciones'], ['/historial.html', 'Historial'],
    ['/memoria-agentes.html', 'Memoria'], ['/base-datos.html', 'Base de Datos'], ['/prospector.html', 'Prospector'], ['/ops-center.html', 'Ops Center'],
  ];
  var SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';


  // Iconos vectoriales compartidos (estilo lineal) — window.ico('phone')
  var IC = {
    phone:'<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    chat:'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    edit:'<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
    search:'<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
    lock:'<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    pin:'<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    truck:'<rect x="1" y="3" width="15" height="13"/><path d="M16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
    chev:'<path d="M6 9l6 6 6-6"/>',
    trash:'<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
    clock:'<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    check:'<path d="M20 6L9 17l-5-5"/>',
    x:'<path d="M18 6L6 18M6 6l12 12"/>',
    send:'<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
    refresh:'<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    alert:'<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
    users:'<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    target:'<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    activity:'<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    book:'<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
    mic:'<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4"/>',
    filter:'<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/>',
    file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    moon:'<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
  };
  window.ico = function (n) { return '<svg class="i" viewBox="0 0 24 24" aria-hidden="true">' + (IC[n] || '') + '</svg>'; };

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  function pintarBoton(btn) {
    var oscuro = root.getAttribute('data-theme') === 'dark';
    btn.innerHTML = oscuro ? SUN : MOON;
  }

  function montar() {
    if (document.getElementById('abs-appbar')) return;
    if (document.querySelector('script[data-no-bar]')) return; // la página trae su propia barra (portal)
    var path = location.pathname.replace(/\/index\.html$/, '/');
    var titulo = (document.body.getAttribute('data-shell-title') || '');
    var bar = document.createElement('header');
    bar.className = 'abs-appbar'; bar.id = 'abs-appbar';
    bar.innerHTML =
      '<div class="abs-appbar-in">' +
        '<a class="abs-brand" href="/"><span class="abs-mark">AB</span><span class="abs-name">ABSTORAGES</span></a>' +
        (titulo ? '<span class="abs-sep"></span><span class="abs-sub">' + esc(titulo) + '</span>' : '') +
        '<nav class="abs-nav" aria-label="Navegación principal">' +
          LINKS.map(function (l) { return '<a href="' + l[0] + '"' + (path === l[0] ? ' class="on" aria-current="page"' : '') + '>' + l[1] + '</a>'; }).join('') +
          '<button class="abs-theme" id="abs-theme" aria-label="Cambiar entre tema claro y oscuro" title="Cambiar tema"></button>' +
        '</nav>' +
      '</div>';
    document.body.insertBefore(bar, document.body.firstChild);
    document.body.classList.add('has-shell');
    var btn = document.getElementById('abs-theme');
    pintarBoton(btn);
    btn.addEventListener('click', function () {
      var nuevo = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', nuevo);
      try { localStorage.setItem(KEY, nuevo); } catch (e) {}
      pintarBoton(btn);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', montar); else montar();
})();
