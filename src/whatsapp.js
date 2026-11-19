'use strict';
const fs = require('node:fs');
const qrcodeTerminal = require('qrcode-terminal');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
} = require('@whiskeysockets/baileys');
const { HttpError } = require('./utils');

const FALLOS_PARA_REINICIAR = 5;   // envíos fallidos seguidos ⇒ se asume socket zombi y se reconecta
const BACKOFF_MAX_MS = 60_000;

/**
 * Mantiene UNA conexión viva con WhatsApp para siempre:
 *  · reconexión con espera exponencial (nunca se rinde, a diferencia del bot base: 10 intentos y muerto)
 *  · logout (401) ⇒ borra la sesión y genera un QR nuevo solo
 *  · ignora eventos de sockets viejos y nunca abre dos conexiones a la vez
 *  · si pasa demasiado tiempo desconectado, sale con código 1 para que Docker/pm2 lo levante limpio
 */
function createWhatsApp({ authDir, log, baileysLog, watchdogMinutes }) {
    let sock = null;
    let estado = 'iniciando';  // iniciando | esperando_qr | conectando | abierto | reconectando | sesion_cerrada
    let qr = null;
    let intentos = 0;
    let arrancando = false;
    let timer = null;
    let desconectadoDesde = Date.now();
    let ultimoCodigo = null;
    let fallosSeguidos = 0;
    let detenido = false;
    let sinVincular = true;    // true mientras la cuenta nunca se ha vinculado: no se vigila, solo espera el escaneo

    const conectado = () => estado === 'abierto' && !!sock;

    function limpiarSocket() {
        if (!sock) return;
        const viejo = sock;
        sock = null;
        try { viejo.ev.removeAllListeners('connection.update'); } catch { /* ya liberado */ }
        try { viejo.ev.removeAllListeners('creds.update'); } catch { /* ya liberado */ }
        try { viejo.end(undefined); } catch { /* ya cerrado */ }
    }

    function programar(ms) {
        if (detenido) return;
        clearTimeout(timer);
        timer = setTimeout(arrancar, ms);
    }

    function marcarDesconectado() {
        if (estado === 'abierto' || !desconectadoDesde) desconectadoDesde = Date.now();
    }

    async function arrancar() {
        if (arrancando || detenido) return;
        arrancando = true;
        try {
            limpiarSocket();
            const { state, saveCreds } = await useMultiFileAuthState(authDir);
            sinVincular = !state.creds.registered;
            let version;
            try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* usa la versión interna */ }

            const nuevo = makeWASocket({
                version,
                auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLog) },
                logger: baileysLog,
                browser: Browsers.ubuntu('Chrome'),
                markOnlineOnConnect: false,   // no marca "en línea": el teléfono sigue notificando normal
                syncFullHistory: false,       // no descarga todo el historial (menos memoria y menos señal de bot)
                generateHighQualityLinkPreview: false,
                keepAliveIntervalMs: 25_000,
                connectTimeoutMs: 30_000,
            });
            sock = nuevo;
            estado = qr ? 'esperando_qr' : 'conectando';

            nuevo.ev.on('creds.update', () => {
                saveCreds().catch((e) => log.error({ err: e.message }, 'no se pudieron guardar las credenciales'));
            });

            nuevo.ev.on('connection.update', (u) => {
                if (nuevo !== sock) return; // evento de un socket que ya descartamos
                const { connection, lastDisconnect, qr: nuevoQr } = u;

                if (nuevoQr) {
                    qr = nuevoQr;
                    estado = 'esperando_qr';
                    log.info('QR listo: ábrelo en GET /qr o escanéalo en la terminal');
                    qrcodeTerminal.generate(nuevoQr, { small: true });
                }

                if (connection === 'open') {
                    estado = 'abierto';
                    qr = null;
                    sinVincular = false;
                    intentos = 0;
                    fallosSeguidos = 0;
                    desconectadoDesde = null;
                    ultimoCodigo = null;
                    log.info('WhatsApp conectado');
                }

                if (connection === 'close') {
                    const codigo = lastDisconnect?.error?.output?.statusCode ?? null;
                    ultimoCodigo = codigo;
                    marcarDesconectado();
                    qr = null; // un QR de una conexión cerrada ya no sirve
                    log.warn({ codigo }, 'conexión cerrada');
                    limpiarSocket();

                    if (codigo === DisconnectReason.loggedOut) {
                        // El teléfono cerró la sesión: las credenciales ya no sirven. Se borran y se pide QR nuevo.
                        estado = 'sesion_cerrada';
                        qr = null;
                        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) { log.error({ err: e.message }, 'no se pudo borrar la sesión'); }
                        log.warn('sesión cerrada desde el teléfono: se generará un QR nuevo');
                        return programar(3000);
                    }
                    estado = 'reconectando';
                    if (codigo === DisconnectReason.restartRequired) return programar(500); // normal justo tras vincular
                    if (codigo === DisconnectReason.connectionReplaced) {
                        // Otra sesión tomó el control: reconectar de inmediato crearía una guerra de sesiones.
                        log.warn('conexión reemplazada por otra sesión; se reintenta en 60 s');
                        return programar(60_000);
                    }
                    intentos++;
                    const espera = Math.min(2 ** Math.min(intentos, 6) * 1000, BACKOFF_MAX_MS) + Math.random() * 1000;
                    log.info({ intento: intentos, en_s: Math.round(espera / 1000) }, 'reintentando conexión');
                    programar(espera);
                }
            });
        } catch (e) {
            log.error({ err: e.message }, 'error iniciando WhatsApp');
            estado = 'reconectando';
            marcarDesconectado();
            intentos++;
            programar(Math.min(2 ** Math.min(intentos, 6) * 1000, BACKOFF_MAX_MS));
        } finally {
            arrancando = false;
        }
    }

    function forzarReconexion() {
        log.warn('demasiados envíos fallidos seguidos: se reinicia la conexión');
        limpiarSocket();
        estado = 'reconectando';
        fallosSeguidos = 0;
        marcarDesconectado();
        programar(1000);
    }

    /** Envuelve una operación de red: cuenta fallos seguidos y los convierte en 503 genéricos. */
    async function protegido(fn) {
        if (!conectado()) throw new HttpError(503, 'WhatsApp no está conectado', 'no_conectado');
        try {
            const r = await fn(sock);
            fallosSeguidos = 0;
            return r;
        } catch (e) {
            if (e instanceof HttpError) throw e;
            fallosSeguidos++;
            log.error({ err: e && e.message, seguidos: fallosSeguidos }, 'fallo de red con WhatsApp');
            if (fallosSeguidos >= FALLOS_PARA_REINICIAR) forzarReconexion();
            throw new HttpError(503, 'No se pudo completar el envío por WhatsApp', 'fallo_envio');
        }
    }

    // Watchdog: si estuvo desconectado demasiado (y no es simplemente esperando un escaneo), reinicio limpio.
    const vigilante = setInterval(() => {
        if (conectado() || sinVincular || estado === 'esperando_qr' || !desconectadoDesde) return;
        if (Date.now() - desconectadoDesde > watchdogMinutes * 60_000) {
            log.error({ minutos: watchdogMinutes }, 'desconectado demasiado tiempo: saliendo para reinicio limpio');
            process.exit(1);
        }
    }, 30_000);
    vigilante.unref();

    return {
        iniciar: arrancar,
        detener() {
            detenido = true;
            clearTimeout(timer);
            clearInterval(vigilante);
            limpiarSocket();
        },
        isConnected: conectado,
        getQr: () => qr,
        status: () => ({
            connected: conectado(),
            state: estado,
            reconnect_attempts: intentos,
            last_disconnect_code: ultimoCodigo,
            disconnected_since: desconectadoDesde ? new Date(desconectadoDesde).toISOString() : null,
        }),
        async onWhatsApp(numero) {
            return protegido(async (s) => {
                const r = await s.onWhatsApp(`${numero}@s.whatsapp.net`);
                const x = Array.isArray(r) ? r[0] : null;
                return x && x.exists ? { exists: true, jid: x.jid } : { exists: false };
            });
        },
        sendText: (jid, text) => protegido((s) => s.sendMessage(jid, { text })),
        sendDocument: (jid, { buffer, fileName, caption, mimetype }) =>
            protegido((s) => s.sendMessage(jid, { document: buffer, mimetype, fileName, caption: caption || undefined })),
    };
}

module.exports = { createWhatsApp };
