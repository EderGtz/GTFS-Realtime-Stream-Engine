# --- Build stage ---
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run generate:types
RUN npm run build

# Stage non-JS assets into the dist tree so the runtime stage only
# needs one COPY.  Because tsconfig has rootDir: ".", tsc emits to
# dist/src/, not dist/ — proto and generated go alongside the compiled
# output at dist/src/proto/ and dist/src/generated/.
RUN cp -r src/proto dist/src/proto
RUN cp -r src/generated dist/src/generated

# --- Runtime stage ---
FROM node:24-alpine AS runtime
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production

CMD ["node", "dist/src/index.js"]