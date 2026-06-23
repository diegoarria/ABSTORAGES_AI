/**
 * SARA Widget — ABSTORAGES Logistics Solutions
 *
 * Copia este snippet en tu landing page:
 *
 *   <script
 *     src="https://TU_SERVIDOR/sara-widget.js"
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
  if (window.__saraWidget) return;
  window.__saraWidget = true;

  const s         = document.currentScript || document.querySelector('script[src*="sara-widget"]');
  const BASE      = s ? new URL(s.src).origin : '';
  const COLOR     = s?.dataset.color    || '#1a3a8f';
  const LABEL     = s?.dataset.label    || 'Cotiza aquí';
  const AUTOOPEN  = s?.dataset.autoopen === 'true';

  // ── Estilos ──────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #_sara_btn {
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
    #_sara_btn:hover { transform: translateY(-2px); box-shadow: 0 7px 28px rgba(0,0,0,.45); }
    #_sara_wrap {
      position: fixed; bottom: 88px; right: 24px; z-index: 2147483645;
      width: 360px; height: 540px;
      border-radius: 16px; overflow: hidden;
      box-shadow: 0 12px 48px rgba(0,0,0,.5);
      display: none; border: 1px solid rgba(255,255,255,.08);
      transition: opacity .2s, transform .2s;
      opacity: 0; transform: scale(.95) translateY(8px);
    }
    #_sara_wrap.open {
      display: block; opacity: 1; transform: scale(1) translateY(0);
    }
    #_sara_wrap iframe { width: 100%; height: 100%; border: none; display: block; }
    @media (max-width: 500px) {
      #_sara_wrap { width: calc(100vw - 16px); height: 68vh; bottom: 0; right: 0;
        border-radius: 16px 16px 0 0; }
      #_sara_btn  { bottom: 16px; right: 16px; }
    }
  `;
  document.head.appendChild(style);

  // ── Botón ─────────────────────────────────────────────────────────────────────
  const ICON_CHAT = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
  const ICON_X    = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  const btn = document.createElement('button');
  btn.id = '_sara_btn';
  btn.innerHTML = `${ICON_CHAT}${LABEL}`;
  btn.setAttribute('aria-label', 'Abrir chat SARA');

  // ── Iframe ────────────────────────────────────────────────────────────────────
  const wrap   = document.createElement('div');
  wrap.id = '_sara_wrap';
  const iframe = document.createElement('iframe');
  iframe.src   = `${BASE}/widget`;
  iframe.title = 'Chat SARA — ABSTORAGES Logistics';
  iframe.setAttribute('loading', 'lazy');
  wrap.appendChild(iframe);

  let open = false;
  btn.addEventListener('click', () => {
    open = !open;
    if (open) {
      wrap.style.display = 'block';
      requestAnimationFrame(() => wrap.classList.add('open'));
      btn.innerHTML = `${ICON_X} Cerrar`;
    } else {
      wrap.classList.remove('open');
      wrap.addEventListener('transitionend', () => { if (!open) wrap.style.display = 'none'; }, { once: true });
      btn.innerHTML = `${ICON_CHAT}${LABEL}`;
    }
  });

  document.body.appendChild(wrap);
  document.body.appendChild(btn);

  if (AUTOOPEN) {
    setTimeout(() => {
      open = true;
      wrap.style.display = 'block';
      requestAnimationFrame(() => wrap.classList.add('open'));
      btn.innerHTML = `${ICON_X} Cerrar`;
    }, 800);
  }
})();
