# syntax=docker/dockerfile:1
# Connects to the EXISTING Neon PostgreSQL database via DATABASE_URL.
# Do NOT add a local Postgres container.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src
COPY landing-data ./landing-data
RUN npx prisma generate
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/prisma ./prisma
COPY landing-data ./landing-data
EXPOSE 3000
CMD ["node", "dist/main.js"]
