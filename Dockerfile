FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@10.28.2
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Keeping the workspace intact makes pnpm's workspace links explicit and usable.
# Smaller, production-only images can be introduced when needed.
FROM build AS api
ENV NODE_ENV=production
USER node
CMD ["node", "apps/api/dist/index.js"]

FROM build AS worker
ENV NODE_ENV=production
USER node
CMD ["node", "apps/worker/dist/index.js"]

FROM build AS migrate
ENV NODE_ENV=production
USER node
CMD ["node", "packages/database/dist/migrate.js"]

FROM nginx:1.28-alpine AS web
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
