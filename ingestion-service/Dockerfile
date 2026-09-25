# --- Build stage ---
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run generate:types
RUN npm run build

RUN cp -r src/proto dist/proto
RUN cp -r src/generated dist/generated

# --- Runtime stage ---
FROM node:24-alpine AS runtime
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

CMD ["node", "dist/index.js"]