# Signal Box hub. Runs on any host with a long-running container and a persistent volume
# (Railway, Render, Fly.io, a VPS). Not suitable for serverless platforms like Vercel:
# the hub keeps WebSocket connections open and stores SQLite + repo mirrors on disk.
FROM node:24-bookworm-slim

# git: the hub keeps bare mirrors of room repos to verify merge conflicts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

ENV NODE_ENV=production \
    COLAB_HOST=0.0.0.0 \
    COLAB_PORT=3003 \
    COLAB_DATA_DIR=/data \
    COLAB_TRUST_PROXY=1
# Mount a persistent volume here: the database (accounts, rooms, chat) and repo mirrors.
VOLUME /data
EXPOSE 3003
CMD ["npx", "tsx", "server/index.ts"]
