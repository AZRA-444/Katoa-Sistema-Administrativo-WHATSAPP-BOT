# Katoa · Bot de WhatsApp (puente HTTP → WhatsApp)

Recibe las facturas de la PWA y las entrega por WhatsApp. Reemplaza al bot base: mismo concepto (Baileys + Express),
pero con el contrato que espera `api/_whatsapp.py` y protegido para producción.

## Contrato con la PWA

| PWA envía | Bot responde | La PWA lo interpreta como |
|---|---|---|
| `POST /send-document` `{to, filename, pdf_base64, caption}` + header `x-api-key` | `200` | `enviado` |
| (número sin WhatsApp) | `404` con `code: "sin_whatsapp"` | `sin_whatsapp` |
| (bot desconectado, clave mala, timeout, cola llena…) | `401/429/503/504…` | `no_disponible` |

## Qué lo hace «blindado»

- **API key obligatoria** (comparación en tiempo constante, freno a fuerza bruta: 10 fallos/min → 429). Se valida *antes* de leer el cuerpo. Sin `API_KEY` de ≥16 caracteres el bot ni arranca.
- **Anti-duplicados:** la PWA no reintenta sola, pero el usuario puede pulsar «Reintentar». Si la misma factura al mismo número llega de nuevo (90 s por defecto), el bot **no vuelve a mandarla**: se engancha al envío en curso o confirma el ya hecho. Un envío que falló sí se puede reintentar.
- **Responde antes del límite de la PWA:** tope de 7 s (la PWA espera 8 s). Si WhatsApp se cuelga, responde `504` y el envío sigue en segundo plano sin duplicarse.
- **Cola serial con pausa aleatoria** (0,4–1,2 s) entre envíos: ritmo humano, menos riesgo de bloqueo de WhatsApp.
- **Reconexión infinita** con espera exponencial (el bot base se rendía tras 10 intentos y quedaba muerto).
- **Logout desde el teléfono:** borra la sesión inválida y genera un QR nuevo solo.
- **Detecta conexión zombi:** 5 envíos fallidos seguidos ⇒ reinicia la conexión. Si pasa 15 min desconectado, el proceso sale y Docker lo levanta limpio.
- **Validaciones:** teléfono (acepta `0412-1234567`, `+58 412…`, `4121234567`, extranjeros con código), PDF real (`%PDF-`), tamaño máximo, nombre de archivo saneado.
- **Logs sin datos sensibles:** teléfonos enmascarados, nunca la clave ni el PDF.

## Despliegue (VPS con Docker)

> ⚠️ **No sirve Vercel/serverless para el bot:** Baileys necesita un proceso permanente y un disco persistente para la sesión.
> Cualquier VPS pequeño (1 GB de RAM sobra) con Docker, o Railway/Render/Fly con volumen persistente.

1. Copia esta carpeta al servidor y crea el `.env`:
   ```bash
   cp .env.example .env
   # genera la clave y pégala en API_KEY=
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Levanta: `docker compose up -d --build`
3. Pon un proxy HTTPS delante (el compose solo expone `127.0.0.1:5000`). Con Caddy basta:
   ```
   bot.midominio.com {
       reverse_proxy 127.0.0.1:5000
   }
   ```
   y añade `TRUST_PROXY=1` al `.env`.
4. En **Vercel → Environment Variables**:
   - `WHATSAPP_BOT_URL` = `https://bot.midominio.com` (sin barra final)
   - `WHATSAPP_BOT_KEY` = el mismo valor de `API_KEY`
   
   Vuelve a desplegar la PWA.

### Vincular el teléfono (una sola vez)

Abre `https://bot.midominio.com/qr?key=TU_API_KEY` y escanea desde WhatsApp → *Dispositivos vinculados*.
La página se refresca sola. (El QR dura segundos y requiere tu teléfono; aun así, abre esa URL solo mientras vinculas.)
También sale en `docker compose logs -f`.

La sesión queda en el volumen `wa_data`: sobrevive a reinicios y actualizaciones. **No borres ese volumen** o tendrás que vincular otra vez.

## Operación

```bash
curl -H "x-api-key: $API_KEY" https://bot.midominio.com/status   # estado, intentos, última causa de desconexión
curl https://bot.midominio.com/health                            # público, para UptimeRobot/etc.
docker compose logs -f --tail=100
docker compose up -d --build                                     # actualizar
```

`/status` → `state`: `abierto` · `esperando_qr` · `reconectando` · `sesion_cerrada`.

## Buenas prácticas para no perder el número

- Usa un número **dedicado** al negocio, con WhatsApp ya usado normalmente (no uno recién creado).
- Esta librería no es oficial: WhatsApp puede restringir números que envían mucho a quien no los conoce. El bot ya serializa y espacia los envíos; mantén los mensajes a clientes que realmente compraron.
- Para volumen alto o garantías contractuales, el camino es la API oficial (WhatsApp Cloud API). El contrato HTTP de este bot permitiría cambiarlo sin tocar la PWA.

## Prueba en local (antes de desplegar)

Requisitos: **Node.js 20.6 o superior** y **Git** (Baileys descarga una dependencia desde GitHub).

> **Windows:** no trabajes dentro de OneDrive (`Escritorio`, `Documentos`…). OneDrive bloquea `node_modules` (error `EPERM`)
> y además **subiría a la nube la sesión de WhatsApp**. Usa una carpeta como `C:\katoa-bot`.
>
> **npm 12:** bloquea por defecto las dependencias desde GitHub (`EALLOWGIT`). El proyecto incluye un `.npmrc`
> con `allow-git=all` que lo permite solo aquí (el commit de `libsignal` está fijado en `package-lock.json`).

```bash
# 1. Solo la primera vez: evita el error "Permission denied (publickey)" al instalar
git config --global url."https://github.com/".insteadOf ssh://git@github.com/

# 2. Instalar y configurar
npm install
cp .env.example .env        # en Windows: copy .env.example .env
#   edita .env → API_KEY=una-clave-de-al-menos-16-caracteres
#   y, para no mezclar con producción:  AUTH_DIR=./session_local

# 3. Arrancar (lee el .env solo)
npm run dev
```

1. Aparece un **QR en la terminal** (o ábrelo en `http://localhost:5000/qr?key=TU_API_KEY`). Escanéalo con un WhatsApp de **prueba**: *Dispositivos vinculados → Vincular un dispositivo*.
2. Cuando el log diga `WhatsApp conectado`, manda un PDF a tu propio número:
   ```bash
   npm run prueba -- 04121234567            # PDF de prueba generado por el script
   npm run prueba -- 04121234567 factura.pdf # tu propio PDF
   ```
   Respuesta esperada: `HTTP 200 {"status":"success",...}` y el documento llega al teléfono.
3. Repite el mismo comando enseguida: debe responder `200` con `"duplicate":true` y **no** llegar un segundo PDF.
4. Comprueba el estado: `curl -H "x-api-key: TU_API_KEY" http://localhost:5000/status`

Para probar **la PWA contra tu bot local**, Vercel no puede ver `localhost`. Dos caminos:
- **Túnel temporal:** `cloudflared tunnel --url http://localhost:5000` (o `ngrok http 5000`) da una URL https; ponla como `WHATSAPP_BOT_URL` en un despliegue de *Preview* de Vercel (no en producción) junto con `WHATSAPP_BOT_KEY` = tu `API_KEY`.
- **PWA también en local:** `vercel dev` con `WHATSAPP_BOT_URL=http://localhost:5000`.

Una vez probado, **borra la carpeta `session_local`** (o desvincula el dispositivo desde el teléfono) y en el servidor vincula el número definitivo.

## Desarrollo

```bash
npm install
npm test        # 27 pruebas: utilidades + capa HTTP con WhatsApp simulado
API_KEY=una-clave-de-al-menos-16-caracteres npm start
```

## Variables de entorno

Ver `.env.example`. Solo `API_KEY` es obligatoria.
