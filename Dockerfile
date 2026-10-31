FROM node:22-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 needs to compile its native binding if no prebuild matches the image's libc/arch.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Container network namespace is private to this container; see server.ts's PUBLIC_HOST comment.
ENV HOST=0.0.0.0
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY config ./config
COPY contracts ./contracts
COPY src ./src
RUN mkdir -p /app/data
EXPOSE 8787
CMD ["node", "--import", "tsx", "src/orchestrator/server.ts"]
