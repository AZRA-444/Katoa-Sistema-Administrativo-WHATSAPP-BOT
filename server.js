'use strict';
const pino = require('pino');
const { createApp } = require('./src/app');
const { createWhatsApp } = require('./src/whatsapp');

// ── Configuración (variables de entorno) ───────────────────────────────────
const num = (nombre, defecto) => {
    const v = Number(process.env[nombre]);
    return Number.isFinite(v) && v > 0 ? v : defecto;
};

const API_KEY = process.env.API_KEY || '';
if (API_KEY.length < 16) {
    console.error('❌ Falta API_KEY (mínimo 16 caracteres). Debe ser la MISMA que WHATSAPP_BOT_KEY en Vercel.');
    console.error('   Genera una con:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
}

const maxPdfMb = num('MAX_PDF_MB', 10);
const config = {
    port: num('PORT', 5000),
    host: process.env.HOST || '0.0.0.0',
    authDir: process.env.AUTH_DIR || 'session_auth',
    countryCode: (process.env.DEFAULT_COUNTRY_CODE || '58').replace(/\D/g, '') || '58',
    maxPdfBytes: Math.round(maxPdfMb * 1024 * 1024),
    bodyLimit: `${Math.ceil(maxPdfMb * 1.4) + 1}mb`, // base64 pesa ~1,37× el PDF
    sendTimeoutMs: num('SEND_TIMEOUT_MS', 7000),     // menor que el timeout de lectura de la PWA (8 s)
    dedupeMs: num('DEDUPE_SECONDS', 90) * 1000,
    queueMax: num('QUEUE_MAX', 20),
    gapMinMs: num('GAP_MIN_MS', 400),
    gapMaxMs: num('GAP_MAX_MS', 1200),
    watchdogMinutes: num('WATCHDOG_MINUTES', 15),
    trustProxy: process.env.TRUST_PROXY ? (Number.isNaN(Number(process.env.TRUST_PROXY)) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY)) : false,
};

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const baileysLog = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' });

// ── Errores globales ───────────────────────────────────────────────────────
// Un error no capturado deja el proceso en estado incierto: se registra y se sale para que
// Docker/pm2 lo levante limpio (la sesión de WhatsApp persiste en disco). Las promesas
// rechazadas sueltas (ruido típico de librerías de red) solo se registran.
process.on('uncaughtException', (err) => {
    log.fatal({ err: err && err.stack }, 'uncaughtException: reiniciando');
    process.exit(1);
});
process.on('unhandledRejection', (err) => log.error({ err: err && (err.stack || String(err)) }, 'unhandledRejection'));

// ── Arranque ───────────────────────────────────────────────────────────────
const wa = createWhatsApp({ authDir: config.authDir, log, baileysLog, watchdogMinutes: config.watchdogMinutes });
const app = createApp({ apiKey: API_KEY, wa, log, config });

const server = app.listen(config.port, config.host, () => {
    log.info({ puerto: config.port }, 'API lista');
    wa.iniciar();
});
// Evita conexiones colgadas (Slowloris) sin cortar envíos legítimos.
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

// ── Apagado limpio ─────────────────────────────────────────────────────────
let cerrando = false;
function apagar(senal) {
    if (cerrando) return;
    cerrando = true;
    log.info({ senal }, 'apagando');
    wa.detener();
    app.locals.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));
