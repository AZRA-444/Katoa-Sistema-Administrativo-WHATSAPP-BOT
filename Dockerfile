FROM node:22-bookworm-slim

# git: Baileys instala "libsignal" desde GitHub. Se fuerza HTTPS porque el lock lo referencia por ssh
# y un servidor sin llave SSH fallaría con "Permission denied (publickey)".
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git config --global url."https://github.com/".insteadOf ssh://git@github.com/ \
    && git config --global --add url."https://github.com/".insteadOf git@github.com:

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./
COPY src ./src

ENV NODE_ENV=production \
    PORT=5000 \
    AUTH_DIR=/data/session_auth
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
