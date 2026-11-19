'use strict';
const crypto = require('node:crypto');

class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Normaliza un teléfono a formato internacional sin "+" (ej. 584121234567).
 * Acepta: 4121234567, 04121234567, 0412-123.4567, +58 412 1234567, 584121234567, 00584121234567,
 *         +58 0412... y números extranjeros que ya traen su código de país.
 * Devuelve null si no puede ser un número válido.
 * Limitación inevitable: un número de 10 dígitos SIN código de país se asume del país por defecto.
 */
function normalizarNumero(raw, codigoPais = '58') {
    let d = String(raw ?? '').replace(/\D/g, '');
    if (!d) return null;

    if (d.startsWith('00')) d = d.replace(/^0+/, '');          // 0058… → 58…
    else if (d.startsWith('0')) d = codigoPais + d.replace(/^0+/, ''); // 0412… → 58412…
    else if (d.length === 10) d = codigoPais + d;              // 412… → 58412…

    // +58 0412… (cero de troncal pegado al código de país)
    if (d.startsWith(codigoPais + '0')) d = codigoPais + d.slice(codigoPais.length).replace(/^0+/, '');

    if (d.length < 11 || d.length > 15) return null;
    // Con el código del país por defecto, el resto debe ser el número nacional completo (10 dígitos).
    if (d.startsWith(codigoPais) && codigoPais === '58' && d.length !== 12) return null;
    return d;
}

/** Enmascara un número para los logs: 5841****567 */
function maskNumero(n) {
    const s = String(n || '');
    return s.length > 7 ? `${s.slice(0, 4)}****${s.slice(-3)}` : '****';
}

/** Nombre de archivo seguro (sin rutas ni caracteres raros) y siempre terminado en .pdf */
function sanitizarNombreArchivo(nombre, porDefecto = 'documento.pdf') {
    let n = String(nombre ?? '').split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
    n = n.slice(0, 100);
    if (!n) return porDefecto;
    return /\.pdf$/i.test(n) ? n : `${n.replace(/\.+$/, '')}.pdf`;
}

/** Decodifica y valida un PDF en base64. Lanza HttpError 400/413. */
function decodificarPdf(b64, maxBytes) {
    if (typeof b64 !== 'string' || !b64) throw new HttpError(400, 'pdf_base64 es requerido', 'pdf_invalido');
    if (Math.floor((b64.length * 3) / 4) > maxBytes + 4) throw new HttpError(413, 'PDF demasiado grande', 'pdf_grande');
    const limpio = b64.replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(limpio)) throw new HttpError(400, 'pdf_base64 no es base64 válido', 'pdf_invalido');
    const buf = Buffer.from(limpio, 'base64');
    if (buf.length > maxBytes) throw new HttpError(413, 'PDF demasiado grande', 'pdf_grande');
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, 'El archivo no es un PDF', 'pdf_invalido');
    return buf;
}

/** Comparación en tiempo constante (evita ataques por tiempo sobre la API key). */
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
    const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/**
 * Cola serial de envíos con pausa aleatoria entre mensajes: WhatsApp penaliza las ráfagas
 * idénticas y automáticas; enviar de uno en uno y con ritmo humano reduce el riesgo de bloqueo.
 */
class SendQueue {
    constructor({ maxPending = 20, minGapMs = 400, maxGapMs = 1200 } = {}) {
        this.maxPending = maxPending;
        this.minGapMs = minGapMs;
        this.maxGapMs = Math.max(minGapMs, maxGapMs);
        this.pending = 0;
        this.lastEnd = 0;
        this.tail = Promise.resolve();
    }

    run(fn) {
        if (this.pending >= this.maxPending) {
            return Promise.reject(new HttpError(429, 'Cola de envíos llena. Intenta de nuevo en unos segundos.', 'cola_llena'));
        }
        this.pending++;
        const job = this.tail.then(async () => {
            const gap = this.minGapMs + Math.random() * (this.maxGapMs - this.minGapMs);
            const espera = this.lastEnd + gap - Date.now();
            if (espera > 0) await sleep(espera);
            try {
                return await fn();
            } finally {
                this.lastEnd = Date.now();
            }
        });
        const liberar = () => { this.pending--; };
        this.tail = job.then(liberar, liberar); // la cola nunca queda rota por un envío fallido
        return job;
    }
}

/**
 * Anti-duplicados. Si la PWA (o el usuario) repite la misma petición porque la respuesta tardó,
 * NO se manda otro documento al cliente: se espera al envío en curso o se confirma el ya hecho.
 * Un envío fallido libera la clave, así el reintento sí vuelve a intentarlo.
 */
class Dedupe {
    constructor(ttlMs = 90_000) {
        this.ttlMs = ttlMs;
        this.map = new Map();
        this.timer = setInterval(() => this.purgar(), 30_000);
        this.timer.unref();
    }

    static clave(...partes) {
        const h = crypto.createHash('sha256');
        for (const p of partes) h.update(p).update('\0');
        return h.digest('hex');
    }

    get(clave) {
        const e = this.map.get(clave);
        if (!e) return null;
        if (e.estado === 'enviado' && e.expira <= Date.now()) {
            this.map.delete(clave);
            return null;
        }
        return e;
    }

    iniciar(clave, promesa) {
        const entrada = { estado: 'en_curso', promesa, expira: Infinity };
        this.map.set(clave, entrada);
        promesa.then(
            () => { entrada.estado = 'enviado'; entrada.expira = Date.now() + this.ttlMs; },
            () => { if (this.map.get(clave) === entrada) this.map.delete(clave); },
        );
        return entrada;
    }

    purgar() {
        const ahora = Date.now();
        for (const [k, e] of this.map) if (e.estado === 'enviado' && e.expira <= ahora) this.map.delete(k);
    }

    close() { clearInterval(this.timer); }
}

module.exports = {
    HttpError, sleep, normalizarNumero, maskNumero, sanitizarNombreArchivo,
    decodificarPdf, safeEqual, SendQueue, Dedupe,
};
