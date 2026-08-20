// ── Visión — descarga imágenes/documentos de WhatsApp (Twilio y 2Chat) y los
// convierte en bloques multimodales para Claude ────────────────────────────
// Usado para evidencias reales que mandan choferes/proveedores: fotos de la
// caja seca (limpieza, filtraciones, piso, parches), carta porte, y otros
// documentos oficiales — Claude los analiza directo, no hace falta que un
// humano los revise primero.
const MAX_ARCHIVO_BYTES = 5 * 1024 * 1024; // 5MB por archivo — límite práctico recomendado por Anthropic para imágenes base64

// Descarga un archivo (imagen o PDF) desde una URL — soporta auth básica
// (Twilio exige Account SID/Token para bajar sus media URLs; 2Chat las sirve
// públicas, sin auth).
async function descargarArchivo(url, { basicAuth } = {}) {
  const headers = {};
  if (basicAuth) headers['Authorization'] = `Basic ${Buffer.from(basicAuth).toString('base64')}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`No se pudo descargar el archivo (HTTP ${res.status})`);
  const mediaType = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ARCHIVO_BYTES) {
    throw new Error(`Archivo demasiado grande (${(buf.length / 1024 / 1024).toFixed(1)}MB, máx ${MAX_ARCHIVO_BYTES / 1024 / 1024}MB)`);
  }
  return { data: buf.toString('base64'), mediaType };
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
  return null; // tipo no soportado (audio, video, etc.) — se ignora, no se manda a Claude
}

// Descarga una lista de URLs y arma el content[] completo para el mensaje de
// usuario — archivos primero, texto al final (orden recomendado por
// Anthropic para que el texto que sigue tenga el contexto de la imagen).
async function construirContenidoConArchivos(urls, texto, { basicAuth } = {}) {
  const bloques = [];
  for (const url of urls) {
    try {
      const archivo = await descargarArchivo(url, { basicAuth });
      const bloque = bloqueParaArchivo(archivo);
      if (bloque) bloques.push(bloque);
      else console.warn(`[vision] Tipo de archivo no soportado (${archivo.mediaType}), se ignora:`, url);
    } catch (e) {
      console.error('[vision] Error descargando archivo:', url, e.message);
    }
  }
  bloques.push({ type: 'text', text: texto || '(el remitente mandó un archivo sin texto — analízalo y responde según lo que encuentres)' });
  return { content: bloques, adjuntos: bloques.filter(b => b.type !== 'text').length };
}

module.exports = { descargarArchivo, bloqueParaArchivo, construirContenidoConArchivos, MAX_ARCHIVO_BYTES };
