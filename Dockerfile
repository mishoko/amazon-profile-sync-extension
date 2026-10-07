# The local Waybill server (server/). Dependencies are installed only here,
# never into the repo, which Chrome loads as the unpacked extension.
FROM node:22-alpine AS runtime
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server/server.mjs server/websocket.mjs ./
COPY server/store/memory.mjs server/store/postgres.mjs server/store/matching.mjs ./store/
COPY server/migrations ./migrations
USER node
ENV WAYBILL_HOST=0.0.0.0
EXPOSE 4417
CMD ["node", "server.mjs"]

# The same image plus the test files: docker compose --profile test run --rm tests
FROM runtime AS test
COPY server/server.test.mjs ./
COPY server/store/store.test.mjs ./store/
CMD ["node", "--test"]
