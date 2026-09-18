FROM node:24-bookworm-slim

WORKDIR /app
COPY build/generator/package.json build/generator/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npx playwright install --with-deps chromium \
    && apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    && mv /root/.cache/ms-playwright /opt/ms-playwright \
    && chmod -R a+rX /opt/ms-playwright \
    && mkdir -p /var/lib/generator
COPY server ./server
COPY build/generator/setting*.json /tmp/generator-settings/
COPY build/generator/install-settings.mjs ./build/generator/install-settings.mjs
RUN node build/generator/install-settings.mjs /tmp/generator-settings /app/config/claude/settings.json \
    && rm -rf /tmp/generator-settings /app/build
ENV NODE_ENV=production \
    PATH=/app/node_modules/.bin:$PATH \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    CLAUDE_CONFIG_DIR=/tmp/generator-claude \
    GENERATOR_CLAUDE_SETTINGS=/app/config/claude/settings.json \
    GENERATOR_HOST=0.0.0.0 \
    GENERATOR_PORT=4502 \
    GENERATOR_DATA_DIR=/var/lib/generator
EXPOSE 4502
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/generator/main.mjs"]
