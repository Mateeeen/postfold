# Single always-on container: HTTP API + the one queue worker.
#
# Not serverless, deliberately. The worker polls continuously and SQLite is a
# single-writer file on a persistent volume — see README "Scaling".

FROM node:22-slim AS build
WORKDIR /app

# better-sqlite3 is a native module; it needs a toolchain to compile when no
# prebuilt binary matches the platform.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY db ./db
RUN npx tsc -p tsconfig.json

# Drop dev dependencies for the runtime image, keeping the compiled native
# module that npm ci already built.
RUN npm prune --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY db ./db

# The database lives on a mounted volume, never in the image layer.
ENV DATABASE_PATH=/data/postfold.db
ENV PORT=3000
EXPOSE 3000

# Migrations run on boot: the container is the only writer, and a schema
# change must land before the worker touches the file.
CMD ["node", "dist/src/scripts/start.js"]
