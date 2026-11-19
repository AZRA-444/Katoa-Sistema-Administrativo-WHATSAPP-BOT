#!/usr/bin/env node
'use strict';
/**
 * Envía un PDF de prueba al bot (local o remoto), igual que lo hace la PWA.
 *
 *   node scripts/enviar-prueba.js 04121234567                 → manda un PDF de prueba generado aquí
 *   node scripts/enviar-prueba.js 04121234567 factura.pdf     → manda tu propio PDF
 *
 * Variables: API_KEY (obligatoria) · BOT_URL (por defecto http://localhost:5000)
 * Si existe un archivo .env en la carpeta, se lee solo.
 */
const fs = require('node:fs');
const path = require('node:path');

try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* sin .env: se usan las variables del sistema */ }

const [telefono, archivo] = process.argv.slice(2);
const API_KEY = process.env.API_KEY;
const BOT_URL = (process.env.BOT_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, '');

if (!telefono || !API_KEY) {
    console.error('Uso: node scripts/enviar-prueba.js <telefono> [archivo.pdf]\nNecesita API_KEY en el .env o en el entorno.');
    process.exit(1);
}

/** PDF mínimo pero válido (1 página con texto), con tabla xref correcta: WhatsApp lo abre sin problema. */
function pdfDePrueba() {
    const texto = `Prueba Katoa - ${new Date().toLocaleString('es-VE')}`;
    const contenido = `BT /F1 20 Tf 72 720 Td (${texto}) Tj ET`;
    const objs = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${contenido.length} >>\nstream\n${contenido}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let out = '%PDF-1.4\n';
    const offsets = [];
    objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach((o) => { out += `${String(o).padStart(10, '0')} 00000 n \n`; });
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}

(async () => {
    const pdf = archivo ? fs.readFileSync(archivo) : pdfDePrueba();
    const nombre = archivo ? path.basename(archivo) : `Prueba-${Date.now()}.pdf`;
    console.log(`→ ${BOT_URL}/send-document  (${nombre}, ${pdf.length} bytes) a ${telefono}`);
    try {
        const r = await fetch(`${BOT_URL}/send-document`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
            body: JSON.stringify({ to: telefono, filename: nombre, pdf_base64: pdf.toString('base64'), caption: 'Mensaje de prueba del bot de Katoa ✅' }),
            signal: AbortSignal.timeout(10_000),
        });
        console.log(`← HTTP ${r.status}`, await r.text());
        process.exit(r.ok ? 0 : 1);
    } catch (e) {
        console.error('No se pudo conectar con el bot:', e.message);
        process.exit(1);
    }
})();
