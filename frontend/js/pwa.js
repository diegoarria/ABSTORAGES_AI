// ABSTORAGES AI — PWA: Service Worker + Push Notifications + Install Banner

(function () {
  'use strict';

  // ── 1. Registrar Service Worker ───────────────────────────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then(reg => {
          console.log('[PWA] SW registrado:', reg.scope);
          window._swReg = reg;
        })
        .catch(e => console.warn('[PWA] SW error:', e.message));
    });
  }

  // ── 2. Install Banner (Añadir a pantalla de inicio) ───────────────────────
  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    // Solo mostrar si no está ya instalado y no lo ha descartado antes
    if (!localStorage.getItem('pwa-installed') && !localStorage.getItem('pwa-dismissed')) {
      setTimeout(showInstallBanner, 3000); // Esperar 3s a que cargue la UI
    }
  });

  window.addEventListener('appinstalled', () => {
    localStorage.setItem('pwa-installed', '1');
    hideInstallBanner();
    console.log('[PWA] App instalada');
  });

  function showInstallBanner() {
    let banner = document.getElementById('pwa-install-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'pwa-install-banner';
      banner.className = 'install-banner';
      banner.innerHTML = `
        <div class="install-banner-row">
          <div class="install-banner-icon">🚛</div>
          <div>
            <div class="install-banner-title">Instalar ABSTORAGES AI</div>
            <div class="install-banner-sub">Acceso rápido desde tu pantalla de inicio</div>
          </div>
        </div>
        <div class="install-banner-btns">
          <button class="install-banner-ok" id="pwa-install-ok">Instalar</button>
          <button class="install-banner-x"  id="pwa-install-x">Ahora no</button>
        </div>`;
      document.body.appendChild(banner);

      document.getElementById('pwa-install-ok').addEventListener('click', async () => {
        hideInstallBanner();
        if (deferredPrompt) {
          deferredPrompt.prompt();
          const { outcome } = await deferredPrompt.userChoice;
          if (outcome === 'accepted') localStorage.setItem('pwa-installed', '1');
          deferredPrompt = null;
        }
      });
      document.getElementById('pwa-install-x').addEventListener('click', () => {
        hideInstallBanner();
        localStorage.setItem('pwa-dismissed', '1');
      });
    }
    banner.classList.add('visible');
  }

  function hideInstallBanner() {
    const b = document.getElementById('pwa-install-banner');
    if (b) b.classList.remove('visible');
  }

  // ── 3. Push Notifications ─────────────────────────────────────────────────
  window.PushNotif = {
    supported: 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window,
    enabled: false,

    async init() {
      if (!this.supported) return;
      if (Notification.permission === 'granted') {
        await this._subscribe();
        this.enabled = true;
      }
    },

    async request() {
      if (!this.supported) return false;
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return false;
      await this._subscribe();
      this.enabled = true;
      return true;
    },

    async _subscribe() {
      try {
        const reg = window._swReg || await navigator.serviceWorker.ready;
        // Obtener clave pública VAPID del servidor
        const { publicKey } = await fetch('/api/push/vapid-public-key').then(r => r.json());
        if (!publicKey) return;

        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });

        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(sub),
        });
        console.log('[Push] Suscripción activa');
      } catch (e) {
        console.warn('[Push] Error al suscribir:', e.message);
      }
    },

    // Mostrar banner de solicitud de permisos (no el prompt nativo directo)
    showPermissionBanner() {
      if (!this.supported || Notification.permission !== 'default') return;
      if (localStorage.getItem('push-dismissed')) return;

      let banner = document.getElementById('push-perm-banner');
      if (banner) return;

      banner = document.createElement('div');
      banner.id = 'push-perm-banner';
      banner.className = 'push-banner';
      banner.innerHTML = `
        <div class="push-banner-icon">🔔</div>
        <div class="push-banner-text">
          <div class="push-banner-title">Activar notificaciones</div>
          <div class="push-banner-body">Recibe alertas de nuevas órdenes, carriers y zonas de riesgo</div>
          <div class="push-banner-btns">
            <button class="push-banner-allow" id="push-allow-btn">Activar</button>
            <button class="push-banner-deny"  id="push-deny-btn">No, gracias</button>
          </div>
        </div>`;
      document.body.appendChild(banner);

      document.getElementById('push-allow-btn').addEventListener('click', async () => {
        banner.remove();
        await PushNotif.request();
      });
      document.getElementById('push-deny-btn').addEventListener('click', () => {
        banner.remove();
        localStorage.setItem('push-dismissed', '1');
      });
    },
  };

  // Inicializar push después de que el SW esté listo
  window.addEventListener('load', async () => {
    await PushNotif.init();
    // Mostrar banner de permisos después de 5s (no interrumpir el login)
    if (PushNotif.supported && Notification.permission === 'default') {
      setTimeout(() => PushNotif.showPermissionBanner(), 5000);
    }
  });

  // ── Utilidad: convertir base64 a Uint8Array para VAPID ───────────────────
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }
})();
