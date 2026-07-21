// Push notifications nativas via Capacitor (iOS APNs / Android FCM)
// Se carga SOLO dentro de la app nativa (Capacitor detectado)

(function () {
  if (!window.Capacitor) return; // Solo en app nativa

  const { PushNotifications } = Capacitor.Plugins;
  if (!PushNotifications) return;

  async function initPush() {
    // 1. Pedir permisos
    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') return;

    // 2. Registrar con APNs/FCM
    await PushNotifications.register();
  }

  // Recibir el token del dispositivo → mandarlo al servidor
  PushNotifications.addListener('registration', async (token) => {
    console.log('[CapPush] Token:', token.value);
    try {
      await fetch('/api/push/subscribe-native', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token: token.value, platform: Capacitor.getPlatform() }),
      });
    } catch (e) {
      console.warn('[CapPush] No se pudo registrar token:', e.message);
    }
  });

  PushNotifications.addListener('registrationError', (err) => {
    console.error('[CapPush] Error de registro:', err.error);
  });

  // Notificación recibida con app abierta → mostrar banner in-app
  PushNotifications.addListener('pushNotificationReceived', (notif) => {
    console.log('[CapPush] Notificación recibida:', notif);
    showInAppBanner(notif.title, notif.body, notif.data?.url);
  });

  // Toque en notificación → navegar
  PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    const url = action.notification.data?.url;
    if (url && url !== window.location.pathname) {
      window.location.href = url;
    }
  });

  // Banner in-app cuando llega notificación con la app abierta
  function showInAppBanner(title, body, url) {
    const id = 'cap-notif-banner';
    document.getElementById(id)?.remove();

    const el = document.createElement('div');
    el.id = id;
    el.style.cssText = `
      position:fixed;top:calc(16px + env(safe-area-inset-top));left:12px;right:12px;
      background:#1e3a8a;border:1px solid rgba(96,165,250,.4);border-radius:14px;
      padding:13px 15px;z-index:9999;display:flex;gap:12px;align-items:center;
      box-shadow:0 8px 32px rgba(0,0,0,.6);cursor:pointer;
      animation:slideDown .3s ease;
    `;
    el.innerHTML = `
      <style>@keyframes slideDown{from{transform:translateY(-110%);opacity:0}to{transform:translateY(0);opacity:1}}</style>
      <span style="font-size:22px;flex-shrink:0">🚛</span>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;color:#fff;font-size:14px;margin-bottom:2px">${title || 'ABSTORAGES AI'}</div>
        <div style="color:#93c5fd;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${body || ''}</div>
      </div>
      <button onclick="this.closest('#${id}').remove()" style="background:none;border:none;color:#60a5fa;font-size:18px;cursor:pointer;padding:4px">✕</button>
    `;
    if (url) el.addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON') window.location.href = url; });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  // Inicializar después de que la app esté lista
  document.addEventListener('DOMContentLoaded', initPush);
})();
