# ---- Stage 1: build dashboard -------------------------------------------
FROM node:20-alpine AS dashboard
WORKDIR /build
# Sub-path mount (behind nginx): docker compose build --build-arg VITE_BASE=/monit/
ARG VITE_BASE=/
ENV VITE_BASE=$VITE_BASE
COPY dashboard/package*.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

# ---- Stage 2: server ------------------------------------------------------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=dashboard /build/dist ./public

# COPY preserves the source tree's mode bits and assigns them to root. A build
# context taken off a restrictive mount can arrive 0600/0700, which leaves the
# unprivileged runtime user unable to even traverse /app/src — Node then reports
# a misleading "Cannot find module". Normalise before dropping privileges.
RUN chmod -R a+rX /app && chown -R node:node /app

EXPOSE 8080
USER node
CMD ["node", "src/index.js"]
