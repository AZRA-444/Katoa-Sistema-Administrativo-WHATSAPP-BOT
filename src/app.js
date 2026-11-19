'use strict';
const express = require('express');
const QRCode = require('qrcode');
const {
    HttpError, normalizarNumero, maskNumero, sanitizarNombreArchivo,
    decodificarPdf, safeEqual, SendQueue, Dedupe,
} = require('./utils');

/**
 * Contrato con la PWA (api/_whatsapp.py):
 *   POST /send-document  {to, filename, pdf_base64, caption}   header x-api-key
 *     200 → enviado | 404 {code:'sin_whatsapp'} → el número no tiene WhatsApp | otro → "no disponible"
 *
 * `wa` es el adaptador de WhatsApp:
 *   isConnected() · onWhatsApp(numero) → {exists, jid} · sendText(jid, texto)
 *   sendDocument(jid, {buffer, fileName, caption, mimetype}) · getQr() · status()
 */
function createApp({ apiKey, wa, log, config }) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);

    const queue = new SendQueue({ maxPending: config.queueMax, minGapMs: config.gapMinMs, maxGapMs: config.gapMaxMs });
    const dedupe = new Dedupe(config.dedupeMs);
    app.locals.close = () => dedupe.close();

    app.use((req, res, next) => {
        res.set({
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
        });
        next();
    });

    // ── Público: solo para monitores/healthchecks. No expone nada sensible ──
    app.get('/health', (req, res) => res.json({ status: 'ok', connected: wa.isConnected() }));

    // ── Autenticación (antes de leer cualquier cuerpo) + freno a la fuerza bruta ──
    const fallos = new Map(); // ip → {n, hasta}
    app.use((req, res, next) => {
        const ip = req.ip || 'desconocida';
        const f = fallos.get(ip);
        if (f && f.hasta > Date.now() && f.n >= 10) {
            return res.status(429).json({ status: 'error', message: 'Demasiados intentos. Espera un minuto.', code: 'limite' });
        }
        // /qr admite ?key= solo para poder abrirlo desde el navegador al vincular el teléfono.
        const enviada = req.get('x-api-key') || (req.path === '/qr' ? req.query.key : '');
        if (safeEqual(enviada, apiKey)) return next();

        const vigente = f && f.hasta > Date.now() ? f : { n: 0, hasta: Date.now() + 60_000 };
        vigente.n++;
        fallos.set(ip, vigente);
        if (fallos.size > 5000) fallos.clear(); // tope de memoria
        log.warn({ ip }, 'API key inválida');
        return res.status(401).json({ status: 'error', message: 'No autorizado', code: 'no_autorizado' });
    });

    // ── Estado y vinculación ──
    app.get('/status', (req, res) => {
        res.json({ status: 'ok', ...wa.status(), cola: queue.pending, uptime_s: Math.round(process.uptime()) });
    });

    app.get('/qr', async (req, res, next) => {
        try {
            if (wa.isConnected()) {
                return res.type('html').send(pagina('WhatsApp conectado ✅', '<p>La sesión está activa. No hace falta escanear nada.</p>'));
            }
            const qr = wa.getQr();
            if (!qr) {
                return res.type('html').send(pagina('Esperando el código QR…', '<p>Aún no hay QR disponible. Esta página se actualiza sola.</p>', true));
            }
            const img = await QRCode.toDataURL(qr, { margin: 2, width: 320 });
            res.type('html').send(pagina('Escanea con WhatsApp', `<img alt="QR" src="${img}" width="320" height="320"><p>WhatsApp → Dispositivos vinculados → Vincular un dispositivo.</p>`, true));
        } catch (e) { next(e); }
    });

    app.use(express.json({ limit: config.bodyLimit }));

    // ── Envío con anti-duplicado, cola serial y tope de espera ──
    async function enviar(clave, accion) {
        const previo = dedupe.get(clave);
        if (previo) {
            await conTope(previo.promesa, config.sendTimeoutMs);
            return { duplicado: true };
        }
        const promesa = queue.run(accion);
        dedupe.iniciar(clave, promesa);
        await conTope(promesa, config.sendTimeoutMs);
        return { duplicado: false };
    }

    function revisarConexion() {
        if (!wa.isConnected()) throw new HttpError(503, 'WhatsApp no está conectado', 'no_conectado');
    }

    async function resolverDestino(number) {
        const check = await wa.onWhatsApp(number);
        if (!check || !check.exists) throw new HttpError(404, 'Número no tiene WhatsApp', 'sin_whatsapp');
        return check.jid;
    }

    app.post('/send-document', async (req, res, next) => {
        try {
            const b = req.body && typeof req.body === 'object' ? req.body : {};
            const number = normalizarNumero(b.to, config.countryCode);
            if (!number) throw new HttpError(400, 'Teléfono inválido', 'telefono_invalido');
            const buffer = decodificarPdf(b.pdf_base64, config.maxPdfBytes);
            const fileName = sanitizarNombreArchivo(b.filename);
            const caption = String(b.caption ?? '').slice(0, 1000);
            revisarConexion();

            const clave = Dedupe.clave('doc', number, fileName, buffer);
            const r = await enviar(clave, async () => {
                const jid = await resolverDestino(number);
                await wa.sendDocument(jid, { buffer, fileName, caption, mimetype: 'application/pdf' });
            });
            log.info({ to: maskNumero(number), file: fileName, bytes: buffer.length, duplicado: r.duplicado }, 'documento enviado');
            res.json({ status: 'success', message: 'Enviado correctamente', duplicate: r.duplicado });
        } catch (e) { next(e); }
    });

    // Compatibilidad con el bot anterior.
    app.post('/send-message', async (req, res, next) => {
        try {
            const b = req.body && typeof req.body === 'object' ? req.body : {};
            const number = normalizarNumero(b.to, config.countryCode);
            if (!number) throw new HttpError(400, 'Teléfono inválido', 'telefono_invalido');
            const texto = typeof b.message === 'string' ? b.message.trim() : '';
            if (!texto) throw new HttpError(400, 'Falta el mensaje', 'mensaje_vacio');
            if (texto.length > 4000) throw new HttpError(400, 'Mensaje demasiado largo', 'mensaje_largo');
            revisarConexion();

            const clave = Dedupe.clave('txt', number, texto);
            const r = await enviar(clave, async () => {
                const jid = await resolverDestino(number);
                await wa.sendText(jid, texto);
            });
            log.info({ to: maskNumero(number), duplicado: r.duplicado }, 'mensaje enviado');
            res.json({ status: 'success', message: 'Enviado correctamente', duplicate: r.duplicado });
        } catch (e) { next(e); }
    });

    app.use((req, res) => res.status(404).json({ status: 'error', message: 'Ruta no encontrada', code: 'ruta_no_encontrada' }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err instanceof HttpError) {
            return res.status(err.status).json({ status: 'error', message: err.message, code: err.code });
        }
        if (err.type === 'entity.too.large') {
            return res.status(413).json({ status: 'error', message: 'Cuerpo demasiado grande', code: 'pdf_grande' });
        }
        if (err.type === 'entity.parse.failed') {
            return res.status(400).json({ status: 'error', message: 'JSON inválido', code: 'json_invalido' });
        }
        log.error({ err: err && err.message }, 'error no controlado');
        return res.status(500).json({ status: 'error', message: 'Error interno', code: 'error_interno' });
    });

    return app;
}

function conTope(promesa, ms) {
    let t;
    const tope = new Promise((_, rej) => {
        t = setTimeout(() => rej(new HttpError(504, 'El envío tarda más de lo normal; sigue en curso', 'tiempo_agotado')), ms);
    });
    return Promise.race([promesa, tope]).finally(() => clearTimeout(t));
}

function pagina(titulo, cuerpo, refrescar = false) {
    return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refrescar ? '<meta http-equiv="refresh" content="15">' : ''}
<title>${titulo}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:1rem}</style>
</head><body><main><h1>${titulo}</h1>${cuerpo}</main></body></html>`;
}

module.exports = { createApp };
