# Production image for the Next.js app (Prompt 62 — self-hosted deployment
# packaging). Runs ALONGSIDE the self-hosted Supabase stack in supabase/
# (see docker-compose.production.yml at the repo root) — it does not
# replace or bundle Supabase itself.
#
# Three stages: deps (install with the frozen lockfile) -> builder (yarn
# build, output: "standalone" per next.config.ts) -> runner (slim runtime
# image with only what a request needs).
#
# Build (see README.md "Production deployment" for the full explanation of
# why the two NEXT_PUBLIC_* build args below exist and what they must be
# set to):
#
#   docker build \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=https://supabase.example.com \
#     --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key \
#     -t beyonddndbeyond-app .
#
# Run (normally via docker-compose.production.yml, not directly):
#
#   docker run -p 3000:3000 \
#     -e SUPABASE_SERVICE_ROLE_KEY=... \
#     -e ANTHROPIC_API_KEY=... \
#     beyonddndbeyond-app

ARG NODE_VERSION=22-bookworm-slim

#### deps ####
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json yarn.lock ./
# --frozen-lockfile: fail rather than silently drift from the committed
# yarn.lock, same guarantee CI would want.
RUN yarn install --frozen-lockfile

#### builder ####
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* variables are inlined into the JS bundle by `next build` —
# both the browser bundle AND this app's server-side code (supabase-server.ts,
# supabase-middleware.ts, the /api/health route) read
# process.env.NEXT_PUBLIC_SUPABASE_URL, and Next.js's build-time inlining
# rewrites every one of those references to the literal value baked in
# here, everywhere, permanently, for this image. There is no way to
# override it later with `docker run -e` — the browser already downloaded
# the value as a string literal in a static .js file. Rotating the anon
# key or moving to a new domain means rebuilding the image with new
# --build-arg values, not just restarting the container. See README.md for
# what value these two must actually be.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}
ENV NEXT_TELEMETRY_DISABLED=1

RUN yarn build

#### runner ####
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

# poppler-utils (pdftoppm) is needed at REQUEST time, not just build time —
# the D&D Beyond PDF character import route
# (src/app/campaigns/[id]/characters/import/lib/raster.ts) shells out to it
# on every PDF upload via node:child_process, so it must live in this final
# runtime stage, not just the builder stage. tesseract.js's OCR is pure
# WASM with a vendored trained-data file (copied below with the rest of
# src/) and needs no extra system package.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Standalone's server.js binds this host/port; 3000 matches `yarn dev`/
# `yarn start`'s default and what the Compose healthcheck/NPM guidance below
# assumes.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root: Next.js's own Dockerfile example convention (nextjs:nodejs,
# uid/gid 1001, addgroup/adduser rather than groupadd/useradd — the latter
# warns that 1001 is above Debian's SYS_UID_MAX for a --system account) —
# the standalone server doesn't need root for anything, including writing
# pdftoppm/tesseract's temp files (those go to /tmp, world-writable by
# default).
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 --ingroup nodejs nextjs

# Standalone output only (server.js + the traced production node_modules
# subset) — NOT the full repo's node_modules or source build tooling.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# public/ and .next/static are deliberately excluded from `output:
# "standalone"` (see Next.js's own docs) and must be copied alongside it.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# src/ is NOT part of the standalone trace, but the PDF-import OCR step
# resolves its vendored tessdata language file at request time via a
# process.cwd()-relative path (src/app/campaigns/[id]/characters/import/lib/ocr.ts,
# LANG_PATH = `${process.cwd()}/src/app/campaigns/[id]/characters/import/tessdata`)
# rather than a static import Next's tracer would have picked up — so it
# has to be copied explicitly. Copying the whole src/ tree (not just the
# tessdata path) sidesteps square-bracket route-segment names like
# campaigns/[id]/ being misread as a glob character class by COPY's source
# pattern matching, which a targeted path through that segment would risk.
COPY --from=builder --chown=nextjs:nodejs /app/src ./src

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
