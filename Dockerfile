FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json package-lock.json ./
# The build requires TypeScript and the other development dependencies.
RUN npm ci --include=dev

FROM base AS builder
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
# Only public browser configuration belongs in build arguments.
# Inject server credentials into the running container, never the image build.
ARG NEXT_PUBLIC_DATA_BACKEND=cloudbase
ARG NEXT_PUBLIC_CLOUDBASE_ENV_ID
ARG NEXT_PUBLIC_CLOUDBASE_REGION
ARG NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ENV NEXT_PUBLIC_DATA_BACKEND=$NEXT_PUBLIC_DATA_BACKEND \
    NEXT_PUBLIC_CLOUDBASE_ENV_ID=$NEXT_PUBLIC_CLOUDBASE_ENV_ID \
    NEXT_PUBLIC_CLOUDBASE_REGION=$NEXT_PUBLIC_CLOUDBASE_REGION \
    NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY \
    NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY
# An empty public directory is valid for this project.
RUN mkdir -p public && node cloudbase/scripts/build-container.mjs

FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/api/health').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1));"
CMD ["node", "server.js"]
