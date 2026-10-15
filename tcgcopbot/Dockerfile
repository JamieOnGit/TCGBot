# TCGCopBot server. No npm packages are needed at runtime (Node's built-in
# HTTP server and SQLite), so the image is just Node and the app's files.
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/tcgcopbot.db \
    TRUST_PROXY=1

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web
COPY extension ./extension
COPY scripts ./scripts

# The database lives on a mounted volume at /data. Hosting providers mount
# volumes owned by root, so the server runs as root inside its own VM/container.
RUN mkdir -p /data

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
