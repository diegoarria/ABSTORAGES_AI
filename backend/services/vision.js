// ── Visión — descarga imágenes/documentos/videos de WhatsApp (Twilio y
// 2Chat) y los convierte en bloques multimodales para Claude ──────────────
// Usado para evidencias reales que mandan choferes/proveedores: fotos o
// VIDEOS de la caja seca (limpieza, filtraciones, piso, parches), carta
// porte, y otros documentos oficiales — Claude los analiza directo, no
// hace falta que un humano los revise primero.
//
// Claude no "ve" video de forma nativa — no existe ese tipo de contenido en
// su API. Lo que sí funciona: extraer varios fotogramas repartidos a lo
// largo del clip (con ffmpeg) y mandarlos como si fueran fotos — captura
// casi todo lo visualmente relevante de un recorrido/evidencia en video.
// Esto es 100% automático, nadie tiene que grabar ni mandar nada distinto.
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const MAX_ARCHIVO_BYTES = 5 * 1024 * 1024;   // 5MB — imágenes/PDF (límite práctico recomendado por Anthropic para base64)
const MAX_VIDEO_BYTES   = 60 * 1024 * 1024;  // 60MB — videos de WhatsApp (el video en sí no se manda a Claude, solo los fotogramas extraídos)
const FOTOGRAMAS_POR_VIDEO = 6;

// Descarga un archivo desde una URL — soporta auth básica (Twilio exige
// Account SID/Token para bajar sus media URLs; 2Chat las sirve públicas,
// sin auth). limiteBytes se decide en el llamador según el tipo esperado.
async function descargarBuffer(url, { basicAuth, limiteBytes = MAX_ARCHIVO_BYTES } = {}) {
  const headers = {};
  if (basicAuth) headers['Authorization'] = `Basic ${Buffer.from(basicAuth).toString('base64')}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`No se pudo descargar el archivo (HTTP ${res.status})`);
  const mediaType = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > limiteBytes) {
    throw new Error(`Archivo demasiado grande (${(buf.length / 1024 / 1024).toFixed(1)}MB, máx ${limiteBytes / 1024 / 1024}MB)`);
  }
  return { buf, mediaType };
}

// Compatibilidad con el nombre anterior — devuelve base64 en vez de Buffer.
async function descargarArchivo(url, opts = {}) {
  const { buf, mediaType } = await descargarBuffer(url, opts);
  return { data: buf.toString('base64'), mediaType };
}

function ejecutarFfmpeg(args) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      // ffmpeg manda su output normal a stderr incluso sin error — no se
      // trata "err" como fatal aquí, se revisa el archivo de salida después.
      resolve(String(stderr || stdout || ''));
    });
  });
}

async function obtenerDuracionSeg(rutaVideo) {
  const salida = await ejecutarFfmpeg(['-i', rutaVideo]);
  const m = salida.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

// Extrae N fotogramas repartidos a lo largo del video y los devuelve como
// buffers JPEG — limpia todos sus archivos temporales al terminar, con o
// sin error.
async function extraerFotogramas(bufferVideo, cantidad = FOTOGRAMAS_POR_VIDEO) {
  const id = crypto.randomUUID();
  const rutaVideo = path.join(os.tmpdir(), `${id}.mp4`);
  const rutasFrames = [];
  fs.writeFileSync(rutaVideo, bufferVideo);
  try {
    const duracion = await obtenerDuracionSeg(rutaVideo);
    const timestamps = [];
    for (let i = 0; i < cantidad; i++) {
      timestamps.push(duracion && duracion > 0.5 ? (duracion * (i + 0.5)) / cantidad : i * 1.5);
    }
    const frames = [];
    for (let i = 0; i < timestamps.length; i++) {
      const rutaFrame = path.join(os.tmpdir(), `${id}-${i}.jpg`);
      rutasFrames.push(rutaFrame);
      await ejecutarFfmpeg(['-ss', timestamps[i].toFixed(2), '-i', rutaVideo, '-frames:v', '1', '-q:v', '3', '-y', rutaFrame]);
      if (fs.existsSync(rutaFrame)) frames.push(fs.readFileSync(rutaFrame));
    }
    return frames;
  } finally {
    for (const r of [rutaVideo, ...rutasFrames]) { try { fs.unlinkSync(r); } catch {} }
  }
}

// Arma el bloque de contenido multimodal para Claude — imagen o PDF, según
// el mediaType real detectado al descargar (no confiar ciegamente en lo que
// reporte Twilio/2Chat, a veces viene genérico).
function bloqueParaArchivo({ data, mediaType }) {
  if (mediaType.startsWith('image/')) {
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  }
  if (mediaType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  return null; // tipo no soportado (audio, etc.) — se ignora, no se manda a Claude
}

function esVideo(mediaType) {
  return /^video\//.test(mediaType);
}

// Descarga una lista de URLs y arma el content[] completo para el mensaje de
// usuario — archivos primero, texto al final (orden recomendado por
// Anthropic para que el texto que sigue tenga el contexto de la imagen).
// Los videos se convierten en varios fotogramas (imágenes) automáticamente.
async function construirContenidoConArchivos(urls, texto, { basicAuth } = {}) {
  const bloques = [];
  for (const url of urls) {
    try {
      // HEAD primero para saber el tipo real antes de decidir el límite de
      // tamaño — un video pesa mucho más que una foto y necesita su propio
      // tope. Si el servidor no soporta HEAD, se asume el límite de imagen.
      const headType = await fetch(url, { method: 'HEAD' }).then(r => r.headers.get('content-type') || '').catch(() => '');
      const limiteBytes = esVideo(headType) ? MAX_VIDEO_BYTES : MAX_ARCHIVO_BYTES;
      const { buf, mediaType } = await descargarBuffer(url, { basicAuth, limiteBytes });

      if (esVideo(mediaType)) {
        const frames = await extraerFotogramas(buf, FOTOGRAMAS_POR_VIDEO);
        if (!frames.length) { console.warn('[vision] No se pudo extraer ningún fotograma del video:', url); continue; }
        for (const frame of frames) {
          bloques.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frame.toString('base64') } });
        }
        console.log(`[vision] Video procesado — ${frames.length} fotogramas extraídos:`, url);
        continue;
      }

      const bloque = bloqueParaArchivo({ data: buf.toString('base64'), mediaType });
      if (bloque) bloques.push(bloque);
      else console.warn(`[vision] Tipo de archivo no soportado (${mediaType}), se ignora:`, url);
    } catch (e) {
      console.error('[vision] Error descargando/procesando archivo:', url, e.message);
    }
  }
  bloques.push({
    type: 'text',
    text: texto || '(el remitente mandó un archivo sin texto — analízalo y responde según lo que encuentres)',
  });
  return { content: bloques, adjuntos: bloques.filter(b => b.type !== 'text').length };
}

module.exports = {
  descargarArchivo, descargarBuffer, bloqueParaArchivo, construirContenidoConArchivos,
  extraerFotogramas, esVideo, MAX_ARCHIVO_BYTES, MAX_VIDEO_BYTES,
};
