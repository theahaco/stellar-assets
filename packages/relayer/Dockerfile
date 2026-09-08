# Authline authorization relayer — self-hosting image.
#
# Build from the REPO ROOT (the relayer builds against the workspace SDK):
#   docker build -f packages/relayer/Dockerfile -t authline-relayer .
# Run:
#   docker run -p 8787:8787 -e RELAYER_SECRET=S... \
#     -e RELAYER_API_TOKEN=<16+ chars> authline-relayer
#
# Configuration (see docs/relayer-runbook.md):
#   RELAYER_SECRET     required — funded, LOW-PRIVILEGE ops account (fees only;
#                      boot refuses an authorizer admin or asset issuer key)
#   RELAYER_API_TOKEN  Bearer token for POST /authorize, min 16 chars.
#                      REQUIRED unless HOST is loopback (open authorize spends XLM)
#   STELLAR_NETWORK    TESTNET (default) | PUBLIC
#   RPC_URL            override the default Stellar RPC endpoint
#   DEFAULT_ASSET      asset code when ?asset= is omitted (default EURCV)
#   PORT               listen port (default 8787)
#   HOST               bind interface (default 0.0.0.0)
#   RATE_LIMIT_RPM     per-IP requests/minute on /v1 routes (default 120, 0 = off)
#   MAX_INFLIGHT       max concurrent /v1 requests, 503 beyond (default 8, 0 = off)
#   TRUST_PROXY        1/true — take client IP from Fly-Client-IP / X-Forwarded-For
#                      (only behind a trusted proxy)

FROM node:22-alpine AS build
WORKDIR /app
COPY . .
# --ignore-scripts skips husky's prepare hook (dev-only, not in the image).
RUN npm ci --no-audit --no-fund --ignore-scripts \
	&& npm run build -w @theahaco/authline-relayer \
	&& npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production PORT=8787
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/authline-sdk/package.json packages/authline-sdk/
COPY --from=build /app/packages/authline-sdk/dist packages/authline-sdk/dist
COPY --from=build /app/packages/relayer/package.json packages/relayer/
COPY --from=build /app/packages/relayer/dist packages/relayer/dist
EXPOSE 8787
USER node
CMD ["node", "packages/relayer/dist/server.js"]
