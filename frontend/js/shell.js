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
