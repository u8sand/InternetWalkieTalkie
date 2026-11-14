# Runs anywhere Node's Alpine image does, including every Raspberry Pi:
# linux/arm/v6 (Pi Zero/1), linux/arm/v7 (Pi 2/3, 32-bit OS), linux/arm64 (Pi 3/4/5, 64-bit OS), and amd64.
# The two dependencies are pure JavaScript, so there is nothing to compile.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.mjs ./
ENV NODE_ENV=production PORT=7777 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:7777/health >/dev/null || exit 1
CMD ["node", "server.mjs"]
