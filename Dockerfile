FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/operator-console/package.json ./apps/operator-console/
COPY packages/database/package.json ./packages/database/
COPY packages/redis/package.json ./packages/redis/

RUN npm ci

COPY . .

RUN npm run db:generate

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["npm", "run", "start", "-w", "api"]
