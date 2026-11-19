'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pino = require('pino');
const { createApp } = require('../src/app');
const { HttpError, sleep } = require('../src/utils');

const KEY = 'k'.repeat(32);
const PDF = Buffer.from('%PDF-1.4\n%fake\n%%EOF').toString('base64');
const CONFIG = {
    trustProxy: false, queueMax: 5, gapMinMs: 0, gapMaxMs: 0, dedupeMs: 5000,
    bodyLimit: '2mb', maxPdfBytes: 1024 * 1024, sendTimeoutMs: 400, countryCode: '58',
};

function fakeWa(over = {}) {
    const w = {
        conectado: true, sinWhatsapp: new Set(), enviados: [], textos: [], retardoMs: 0, fallar: false,
        isConnected() { return this.conectado; },
        async onWhatsApp(n) {
            return this.sinWhatsapp.has(n) ? { exists: false } : { exists: true, jid: `${n}@s.whatsapp.net` };
        },
        async sendDocument(jid, d) {
            await sleep(this.retardoMs);
            if (this.fallar) throw new HttpError(503, 'caído', 'fallo_envio');
            this.enviados.push({ jid, ...d });
        },
        async sendText(jid, t) { this.textos.push({ jid, t }); },
        getQr: () => null,
        status() { return { connected: this.conectado, state: 'abierto' }; },
        ...over,
    };
    return w;
}

async function levantar(wa = fakeWa(), cfg = {}) {
    const app = createApp({ apiKey: KEY, wa, log: pino({ level: 'silent' }), config: { ...CONFIG, ...cfg } });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (ruta, body, headers = { 'x-api-key': KEY }) =>
        fetch(base + ruta, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const get = (ruta, headers = { 'x-api-key': KEY }) => fetch(base + ruta, { headers });
    return { wa, base, post, get, cerrar: () => { app.locals.close(); server.close(); } };
}
const doc = (extra = {}) => ({ to: '04121234567', filename: 'Factura-FAC-1.pdf', pdf_base64: PDF, caption: 'Gracias', ...extra });

test('health es público; el resto exige API key', async () => {
    const s = await levantar();
    assert.equal((await s.get('/health', {})).status, 200);
    assert.equal((await s.get('/status', {})).status, 401);
    assert.equal((await s.get('/status', { 'x-api-key': 'mala' })).status, 401);
    assert.equal((await s.post('/send-document', doc(), {})).status, 401);
    assert.equal((await s.get('/status')).status, 200);
    s.cerrar();
});

test('sin API key no se llega a procesar ni un cuerpo gigante', async () => {
    const s = await levantar();
    const r = await s.post('/send-document', 'x'.repeat(5 * 1024 * 1024), {});
    assert.equal(r.status, 401);
    s.cerrar();
});

test('freno a la fuerza bruta: 429 tras 10 claves malas', async () => {
    const s = await levantar();
    for (let i = 0; i < 10; i++) await s.get('/status', { 'x-api-key': 'x' + i });
    assert.equal((await s.get('/status', { 'x-api-key': 'otra' })).status, 429);
    assert.equal((await s.get('/status')).status, 429, 'ni la clave buena pasa durante el bloqueo');
    s.cerrar();
});

test('send-document: camino feliz, normaliza teléfono y arma el documento', async () => {
    const s = await levantar();
    const r = await s.post('/send-document', doc());
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.status, 'success');
    assert.equal(s.wa.enviados.length, 1);
    const e = s.wa.enviados[0];
    assert.equal(e.jid, '584121234567@s.whatsapp.net');
    assert.equal(e.fileName, 'Factura-FAC-1.pdf');
    assert.equal(e.mimetype, 'application/pdf');
    assert.equal(e.caption, 'Gracias');
    assert.ok(e.buffer.subarray(0, 5).toString() === '%PDF-');
    s.cerrar();
});

test('número sin WhatsApp → 404 con code sin_whatsapp (contrato de la PWA)', async () => {
    const wa = fakeWa(); wa.sinWhatsapp.add('584121234567');
    const s = await levantar(wa);
    const r = await s.post('/send-document', doc());
    assert.equal(r.status, 404);
    assert.equal((await r.json()).code, 'sin_whatsapp');
    assert.equal(wa.enviados.length, 0);
    s.cerrar();
});

test('ruta inexistente devuelve 404 con code distinto a sin_whatsapp', async () => {
    const s = await levantar();
    const r = await s.get('/nada');
    assert.equal(r.status, 404);
    assert.equal((await r.json()).code, 'ruta_no_encontrada');
    s.cerrar();
});

test('WhatsApp desconectado → 503 inmediato', async () => {
    const s = await levantar(fakeWa({ conectado: false }));
    const r = await s.post('/send-document', doc());
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, 'no_conectado');
    s.cerrar();
});

test('validaciones: teléfono, PDF falso, base64 malo, JSON roto, sin cuerpo', async () => {
    const s = await levantar();
    assert.equal((await s.post('/send-document', doc({ to: '123' }))).status, 400);
    assert.equal((await s.post('/send-document', doc({ to: undefined }))).status, 400);
    assert.equal((await s.post('/send-document', doc({ pdf_base64: Buffer.from('MZ exe').toString('base64') }))).status, 400);
    assert.equal((await s.post('/send-document', doc({ pdf_base64: '%%%' }))).status, 400);
    assert.equal((await s.post('/send-document', doc({ pdf_base64: undefined }))).status, 400);
    assert.equal((await s.post('/send-document', '{roto')).status, 400);
    assert.equal((await s.post('/send-document', '')).status, 400);
    assert.equal(s.wa.enviados.length, 0);
    s.cerrar();
});

test('PDF mayor al límite → 413 en vez de reventar', async () => {
    const s = await levantar(fakeWa(), { maxPdfBytes: 50 });
    const grande = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(500, 1)]).toString('base64');
    assert.equal((await s.post('/send-document', doc({ pdf_base64: grande }))).status, 413);
    s.cerrar();
});

test('cuerpo mayor al límite de Express → 413 JSON (no HTML)', async () => {
    const s = await levantar(fakeWa(), { bodyLimit: '1kb' });
    const r = await s.post('/send-document', doc({ pdf_base64: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(5000)]).toString('base64') }));
    assert.equal(r.status, 413);
    assert.equal((await r.json()).status, 'error');
    s.cerrar();
});

test('ANTI-DUPLICADO: la misma factura enviada dos veces seguidas se manda UNA sola vez', async () => {
    const s = await levantar();
    assert.equal((await (await s.post('/send-document', doc())).json()).duplicate, false);
    const r2 = await s.post('/send-document', doc());
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).duplicate, true);
    assert.equal(s.wa.enviados.length, 1);
    s.cerrar();
});

test('ANTI-DUPLICADO: reintento mientras el primero sigue en curso NO manda otro', async () => {
    const wa = fakeWa(); wa.retardoMs = 150;
    const s = await levantar(wa);
    const [a, b] = await Promise.all([s.post('/send-document', doc()), s.post('/send-document', doc())]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(wa.enviados.length, 1);
    s.cerrar();
});

test('TIMEOUT: envío lento → 504 rápido; el reintento se engancha al envío en curso (sin duplicar)', async () => {
    const wa = fakeWa(); wa.retardoMs = 700;
    const s = await levantar(wa, { sendTimeoutMs: 200 });
    const t0 = Date.now();
    const r1 = await s.post('/send-document', doc());
    assert.equal(r1.status, 504);
    assert.ok(Date.now() - t0 < 600, 'responde dentro del tope, no espera al envío');
    await sleep(600); // el envío original termina solo
    const r2 = await s.post('/send-document', doc());
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).duplicate, true);
    assert.equal(wa.enviados.length, 1, 'el cliente recibió la factura una sola vez');
    s.cerrar();
});

test('un envío FALLIDO no bloquea el reintento', async () => {
    const wa = fakeWa(); wa.fallar = true;
    const s = await levantar(wa);
    assert.equal((await s.post('/send-document', doc())).status, 503);
    wa.fallar = false;
    const r = await s.post('/send-document', doc());
    assert.equal(r.status, 200);
    assert.equal((await r.json()).duplicate, false);
    assert.equal(wa.enviados.length, 1);
    s.cerrar();
});

test('facturas distintas al mismo número NO se confunden como duplicado', async () => {
    const s = await levantar();
    await s.post('/send-document', doc({ filename: 'Factura-FAC-1.pdf' }));
    const otro = Buffer.from('%PDF-1.4 otra').toString('base64');
    await s.post('/send-document', doc({ filename: 'Factura-FAC-2.pdf', pdf_base64: otro }));
    assert.equal(s.wa.enviados.length, 2);
    s.cerrar();
});

test('/send-message sigue funcionando (compatibilidad) y valida', async () => {
    const s = await levantar();
    const r = await s.post('/send-message', { to: '4121234567', message: 'hola' });
    assert.equal(r.status, 200);
    assert.equal(s.wa.textos[0].jid, '584121234567@s.whatsapp.net');
    assert.equal((await s.post('/send-message', { to: '4121234567' })).status, 400);
    assert.equal((await s.post('/send-message', { to: 'x', message: 'hola' })).status, 400);
    s.cerrar();
});

test('/qr: sin QR espera; conectado avisa; con QR genera imagen', async () => {
    const wa = fakeWa({ conectado: false, getQr: () => null });
    const s = await levantar(wa);
    assert.match(await (await s.get('/qr')).text(), /Esperando/);
    wa.getQr = () => '2@fake-qr-string,abc,def';
    const html = await (await s.get('/qr')).text();
    assert.match(html, /data:image\/png;base64,/);
    wa.conectado = true;
    assert.match(await (await s.get('/qr')).text(), /conectado/i);
    assert.equal((await fetch(s.base + '/qr?key=' + KEY)).status, 200, '?key= funciona solo en /qr');
    assert.equal((await fetch(s.base + '/status?key=' + KEY)).status, 401, '?key= NO vale en otras rutas');
    s.cerrar();
});
