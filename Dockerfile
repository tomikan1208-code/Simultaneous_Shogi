FROM rust:1.90-bookworm AS engine
WORKDIR /build
RUN rustup target add wasm32-unknown-unknown
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build -p shogi-core --target wasm32-unknown-unknown --release --locked

FROM node:22-bookworm-slim AS web
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY scripts/build-web.mjs ./scripts/build-web.mjs
COPY web ./web
COPY --from=engine /build/target/wasm32-unknown-unknown/release/shogi_core.wasm ./web/public/engine.wasm
RUN npm run build:web

FROM node:22-bookworm-slim AS game
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/app/data/rooms
WORKDIR /app
COPY --from=web /build/web/dist ./web/dist
COPY server ./server
COPY scripts/serve.mjs ./scripts/serve.mjs
RUN mkdir -p /app/data/rooms && chown -R node:node /app
USER node
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/serve.mjs"]
