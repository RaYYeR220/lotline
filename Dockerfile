# Lotline API + web UI. Sample mode runs with no external services:
#   docker build -t lotline . && docker run --rm -p 8000:8000 -e SAMPLE_MODE=true lotline
# Live mode reaches Zetaris and Nightshift on the host through host.docker.internal (see README).
FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile \
 && if [ -f apps/web/package.json ]; then pnpm --filter @lotline/web build; fi
ENV NODE_ENV=production PORT=8000 HOST=0.0.0.0 LOGS_DIR=/app/logs
EXPOSE 8000
CMD ["pnpm", "start"]
