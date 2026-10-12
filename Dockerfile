# The local Waybill server (server/), with the event table and chain runner it
# shares with the extension (core/). The layout mirrors the repo, so the same
# relative imports work. Dependencies are installed only here, never into the
# repo, which Chrome loads as the unpacked extension.
FROM node:22-alpine AS runtime
WORKDIR /app
COPY package.json ./
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY core/config.js core/events.js core/chain.js ./core/
COPY server/server.mjs server/handlers.mjs server/websocket.mjs ./server/
COPY server/store/memory.mjs server/store/postgres.mjs server/store/matching.mjs ./server/store/
COPY server/migrations ./server/migrations
USER node
ENV WAYBILL_HOST=0.0.0.0
EXPOSE 4417
CMD ["node", "server/server.mjs"]

# The same image plus the test files: docker compose --profile test run --rm tests
FROM runtime AS test
COPY tests/chain.test.mjs ./tests/
COPY server/server.test.mjs ./server/
COPY server/store/store.test.mjs ./server/store/
CMD ["node", "--test"]
