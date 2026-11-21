# Build stage

FROM oven/bun:1.4.4-alpine AS builder

WORKDIR /app

COPY bun.lock package.json ./
COPY patches patches

RUN bun i --ignore-scripts

COPY . .

RUN bun run build

# Production stage

FROM verekia/nginx-brotli:1.30.7

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/out /usr/share/nginx/html

EXPOSE 80
