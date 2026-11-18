# Self-hosted build of the calculator, served at the site root by nginx.
#
# Unlike the upstream ../Dockerfile this does not re-scrape the wiki: it builds from the committed cdn/json data.
# Item and monster images are loaded from the wiki's CDN at runtime, so cdn/equipment and cdn/monsters are left out
# of the build context (see Dockerfile.dockerignore).
#
# Build from the repo root: docker build -f selfhost/Dockerfile --build-arg BASE_URL=https://example.com .

FROM node:22-slim AS build

ARG BASE_URL="http://localhost"
ARG SHORTLINK_URL="$BASE_URL"

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

# Install dependencies first so they're cached between source changes. Yarn 1 in the node image hands off to the
# Yarn 4 release committed under .yarn/releases (yarnPath in .yarnrc.yml).
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn
RUN --mount=type=cache,target=/root/.yarn YARN_CACHE_FOLDER=/root/.yarn yarn install --immutable

COPY . .

# Serve from the root instead of /osrs-dps (overrides .env.production).
RUN printf 'NEXT_PUBLIC_BASE_URL=%s\nNEXT_PUBLIC_BASE_PATH=\nNEXT_PUBLIC_SHORTLINK_URL=%s\n' \
      "$BASE_URL" "$SHORTLINK_URL" > .env.local

# .git is bind-mounted (when present) so the build can show its commit.
RUN --mount=type=bind,source=.git/,target=.git/ yarn build


FROM nginx:alpine

COPY selfhost/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /srv/out /usr/share/nginx/html
