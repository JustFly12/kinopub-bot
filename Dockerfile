FROM mcr.microsoft.com/playwright:v1.63.0-noble

RUN npm install --global pnpm@11.25.0

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod --ignore-scripts

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PLAYWRIGHT_HEADLESS=true

RUN mkdir -p /app/data

CMD ["node", "dist/bot.js"]
