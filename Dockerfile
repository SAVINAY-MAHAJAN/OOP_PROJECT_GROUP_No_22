FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client ./client
COPY shared ./shared
COPY scripts ./scripts
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=18120
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
COPY --chown=node:node scripts/demo-history.js ./scripts/demo-history.js
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 18120
HEALTHCHECK --interval=20s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "const port=process.env.PORT;fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/start.js"]
