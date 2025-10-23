FROM node:20-slim

ENV NODE_ENV=production \
    npm_config_loglevel=warn

WORKDIR /app

# Copia sólo el manifiesto primero para aprovechar la cache
COPY package.json ./
# Si tienes package-lock.json, copia también y cambia a `npm ci --omit=dev`
# COPY package-lock.json ./
# RUN npm ci --omit=dev
RUN npm install --omit=dev

# Copia el resto (incluye claves y estáticos)
COPY public ./public
COPY server.js server.key server.cert ./

EXPOSE 3000
CMD ["node", "server.js"]
