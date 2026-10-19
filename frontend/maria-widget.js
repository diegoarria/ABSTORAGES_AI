/**
 * MARÍA Widget (antes "SARA Widget") — ABSTORAGES Logistics Solutions
 *
 * Copia este snippet en tu landing page:
 *
 *   <script
 *     src="https://TU_SERVIDOR/maria-widget.js"   (la URL vieja /sara-widget.js sigue funcionando)
 *     data-color="#1a3a8f"
 *     data-label="Cotiza tu flete"
 *     defer
 *   ></script>
 *
 * Atributos opcionales:
 *   data-color  — color del botón flotante (hex, default #1a3a8f)
 *   data-label  — texto del botón (default "Cotiza aquí")
 */
(function () {
  if (window.__mariaWidget || window.__saraWidget) return;
  window.__mariaWidget = window.__saraWidget = true;

  const s         = document.currentScript || document.querySelector('script[src*="maria-widget"], script[src*="sara-widget"]');
  const BASE      = s ? new URL(s.src).origin : '';
  const COLOR     = s?.dataset.color    || '#1a3a8f';
  const LABEL     = s?.dataset.label    || 'Cotiza aquí';
  const AUTOOPEN  = s?.dataset.autoopen === 'true';

  // ── Estilos ──────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #_maria_btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 2147483646;
      background: ${COLOR}; color: #fff;
      border: none; border-radius: 50px;
      padding: 13px 20px; font-size: 14px; font-weight: 600;
      cursor: pointer; box-shadow: 0 4px 20px rgba(0,0,0,.35);
      display: flex; align-items: center; gap: 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      transition: transform .18s, box-shadow .18s;
      line-height: 1;
    }
    #_maria_btn:hover { transform: translateY(-2px); box-shadow: 0 7px 28px rgba(0,0,0,.45); }
    #_maria_btn.open {
      width: 30px; height: 30px; padding: 0; border-radius: 50%;
      justify-content: center; box-shadow: 0 2px 10px rgba(0,0,0,.4);
    }
    #_maria_wrap {
      position: fixed; bottom: 8px; right: 24px; z-index: 2147483645;
      width: 320px; height: 480px;
      border-radius: 16px; overflow: hidden;
      box-shadow: 0 12px 48px rgba(0,0,0,.5);
      display: none; border: 1px solid rgba(255,255,255,.08);
      transition: opacity .2s, transform .2s;
      opacity: 0; transform: scale(.95) translateY(8px);
    }
    #_maria_wrap.open {
      display: block; opacity: 1; transform: scale(1) translateY(0);
    }
    #_maria_wrap iframe { width: 100%; height: 100%; border: none; display: block; }
    @media (max-width: 500px) {
      #_maria_wrap { width: calc(100vw - 24px); height: 58vh; bottom: 14px; right: 12px;
        border-radius: 16px; }
      #_maria_btn  { bottom: 16px; right: 16px; }
    }
  `;
  document.head.appendChild(style);

  // ── Botón ─────────────────────────────────────────────────────────────────────
  const ICON_CHAT = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
  const ICON_X    = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  const btn = document.createElement('button');
  btn.id = '_maria_btn';
  btn.innerHTML = `${ICON_CHAT}${LABEL}`;
  btn.setAttribute('aria-label', 'Abrir chat María');

  // ── Iframe ────────────────────────────────────────────────────────────────────
  const wrap   = document.createElement('div');
  wrap.id = '_maria_wrap';
  const iframe = document.createElement('iframe');
  iframe.src   = `${BASE}/widget`;
  iframe.title = 'Chat María — ABSTORAGES Logistics';
  iframe.setAttribute('loading', 'lazy');
  iframe.setAttribute('allow', 'microphone');
  wrap.appendChild(iframe);

  // Cuando el chat está abierto, el botón se encoge y se pega a la esquina
  // superior derecha de la caja — si se queda en su lugar original (abajo)
  // se monta encima del input/enviar del chat.
  function colocarBotonArriba() {
    const r = wrap.getBoundingClientRect();
    btn.style.bottom = `${window.innerHeight - r.top - 15}px`;
    btn.style.right  = `${window.innerWidth - r.right + 10}px`;
  }
  function restaurarBoton() {
    btn.style.bottom = '';
    btn.style.right  = '';
  }

  let open = false;
  function abrir() {
    open = true;
    wrap.style.display = 'block';
    requestAnimationFrame(() => wrap.classList.add('open'));
    btn.innerHTML = ICON_X;
    btn.classList.add('open');
    btn.setAttribute('aria-label', 'Cerrar chat María');
    colocarBotonArriba();
  }
  function cerrar() {
    open = false;
    wrap.classList.remove('open');
    wrap.addEventListener('transitionend', () => { if (!open) wrap.style.display = 'none'; }, { once: true });
    btn.innerHTML = `${ICON_CHAT}${LABEL}`;
    btn.classList.remove('open');
    btn.setAttribute('aria-label', 'Abrir chat María');
    restaurarBoton();
  }
  btn.addEventListener('click', () => { if (open) cerrar(); else abrir(); });
  window.addEventListener('resize', () => { if (open) colocarBotonArriba(); });

  document.body.appendChild(wrap);
  document.body.appendChild(btn);

  if (AUTOOPEN) setTimeout(abrir, 800);
})();
