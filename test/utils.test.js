'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizarNumero, sanitizarNombreArchivo, decodificarPdf, safeEqual, SendQueue, Dedupe, HttpError, sleep } = require('../src/utils');

test('normalizarNumero: todos los formatos venezolanos dan el mismo número', () => {
    for (const f of ['4121234567', '04121234567', '0412-123.4567', '+58 412 1234567', '584121234567', '00584121234567', '+58 0412 1234567', '(0412) 123 45 67']) {
        assert.equal(normalizarNumero(f), '584121234567', f);
    }
});
test('normalizarNumero: extranjeros con código de país se respetan', () => {
    assert.equal(normalizarNumero('+1 555 123 4567'), '15551234567');
    assert.equal(normalizarNumero('573001234567'), '573001234567');
});
test('normalizarNumero: basura → null', () => {
    for (const f of ['', null, undefined, 'abc', '123', '58412123', '5841212345678901', '58412123456789']) {
        assert.equal(normalizarNumero(f), null, String(f));
    }
});
test('normalizarNumero: acepta número como tipo number (el bot base lanzaba TypeError)', () => {
    assert.equal(normalizarNumero(4121234567), '584121234567');
});
test('sanitizarNombreArchivo', () => {
    assert.equal(sanitizarNombreArchivo('Factura-FAC-123.pdf'), 'Factura-FAC-123.pdf');
    assert.equal(sanitizarNombreArchivo('../../etc/passwd'), 'passwd.pdf');
    assert.equal(sanitizarNombreArchivo('a b/ñ$.exe'), '__.exe.pdf');
    assert.equal(sanitizarNombreArchivo(''), 'documento.pdf');
    assert.equal(sanitizarNombreArchivo('x'.repeat(300)).length <= 104, true);
});
test('decodificarPdf', () => {
    const ok = Buffer.from('%PDF-1.4 hola').toString('base64');
    assert.equal(decodificarPdf(ok, 1000).length, 13);
    assert.throws(() => decodificarPdf(Buffer.from('MZ no es pdf').toString('base64'), 1000), (e) => e.status === 400);
    assert.throws(() => decodificarPdf('###', 1000), (e) => e.status === 400);
    assert.throws(() => decodificarPdf('', 1000), (e) => e.status === 400);
    assert.throws(() => decodificarPdf(Buffer.alloc(5000, 65).toString('base64'), 1000), (e) => e.status === 413);
});
test('safeEqual', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('', 'abc'), false);
    assert.equal(safeEqual(undefined, 'abc'), false);
});
test('SendQueue: serial, en orden, y un fallo no rompe la cola', async () => {
    const q = new SendQueue({ minGapMs: 0, maxGapMs: 0 });
    const orden = [];
    const a = q.run(async () => { await sleep(30); orden.push('a'); });
    const b = q.run(async () => { orden.push('b'); throw new Error('falla'); });
    const c = q.run(async () => { orden.push('c'); return 7; });
    await a;
    await assert.rejects(b);
    assert.equal(await c, 7);
    assert.deepEqual(orden, ['a', 'b', 'c']);
    assert.equal(q.pending, 0);
});
test('SendQueue: respeta pausa entre envíos y rechaza al llenarse', async () => {
    const q = new SendQueue({ minGapMs: 80, maxGapMs: 80, maxPending: 2 });
    const t0 = Date.now();
    const p1 = q.run(async () => {});
    const p2 = q.run(async () => {});
    await assert.rejects(q.run(async () => {}), (e) => e instanceof HttpError && e.status === 429);
    await Promise.all([p1, p2]);
    assert.ok(Date.now() - t0 >= 75, 'el 2.º envío espera la pausa tras el 1.º');
});
test('Dedupe: éxito se recuerda, fallo se libera, TTL expira', async () => {
    const d = new Dedupe(60);
    const k = Dedupe.clave('x', 'y');
    d.iniciar(k, Promise.resolve());
    await sleep(5);
    assert.equal(d.get(k).estado, 'enviado');
    await sleep(70);
    assert.equal(d.get(k), null);

    const k2 = Dedupe.clave('z');
    d.iniciar(k2, Promise.reject(new Error('x')));
    await sleep(5);
    assert.equal(d.get(k2), null);
    d.close();
});
