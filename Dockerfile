# The local Waybill server (server/), with no npm dependencies.
FROM node:22-alpine
WORKDIR /app
COPY server/server.mjs server/websocket.mjs ./server/
USER node
ENV WAYBILL_HOST=0.0.0.0
EXPOSE 4417
CMD ["node", "server/server.mjs"]
