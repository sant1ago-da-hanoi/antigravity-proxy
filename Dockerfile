FROM oven/bun:alpine AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:alpine
WORKDIR /app

ARG GIT_HASH=dev
ENV GIT_HASH=${GIT_HASH}

COPY --from=builder /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./

# Create data directory and config.json with correct permissions
RUN mkdir -p /app/data && echo '{}' > /app/config.json && chown -R bun:bun /app/data /app/config.json

EXPOSE 3000

USER bun
CMD ["bun", "run", "src/server.ts"]
