FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3100 \
    DATA_DIR=/app/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node public ./public
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3100
CMD ["node", "src/server.js"]
