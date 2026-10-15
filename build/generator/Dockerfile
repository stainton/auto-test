ARG BROWSER_BASE
FROM ${BROWSER_BASE}

WORKDIR /app
COPY build/generator/package.json build/generator/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --no-audit --no-fund \
    && node -e "require('node:fs').accessSync(require('playwright').chromium.executablePath())" \
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
