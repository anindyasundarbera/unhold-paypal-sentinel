# Multi-stage Dockerfile for Unhold PayPal Web Service & Reconcile Cron
FROM node:24-slim AS builder

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

FROM node:24-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=10000
ENV HOST=0.0.0.0

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY public/ ./public/
COPY astropods.yml ./astropods.yml

RUN chown -R node:node /app

USER node
EXPOSE 10000

CMD ["node", "dist/server.js"]
