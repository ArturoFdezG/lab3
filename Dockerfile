# Dockerfile — Node 20 slim, sirve HTTPS en 3000
FROM node:20-slim

# Evita prompts locales
ENV NODE_ENV=production \
    npm_config_loglevel=warn

WORKDIR /app

# Dependencias (usa tu package.json existente)
COPY package*.json ./
RUN npm ci --omit=dev

# Copia app (claves y cert incluidos en build context)
COPY public ./public
COPY server.js server.key server.cert ./

EXPOSE 3000

CMD ["node", "server.js"]
