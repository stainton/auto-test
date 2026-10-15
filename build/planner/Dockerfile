ARG BROWSER_BASE
FROM ${BROWSER_BASE}

WORKDIR /app
COPY build/planner/package.json build/planner/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && rm -rf /root/.npm \
    && node -e "require('node:fs').accessSync(require('playwright').chromium.executablePath())" \
    && mkdir -p /var/lib/planner
COPY server ./server
COPY build/planner/setting*.json /tmp/planner-settings/
COPY build/planner/install-settings.mjs ./build/planner/install-settings.mjs
RUN node build/planner/install-settings.mjs /tmp/planner-settings /app/config/claude/settings.json \
    && rm -rf /tmp/planner-settings /app/build
ENV NODE_ENV=production \
    PATH=/app/node_modules/.bin:$PATH \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    CLAUDE_CONFIG_DIR=/tmp/planner-claude \
    PLANNER_CLAUDE_SETTINGS=/app/config/claude/settings.json \
    PLANNER_HOST=0.0.0.0 \
    PLANNER_PORT=4501 \
    PLANNER_DATA_DIR=/var/lib/planner
EXPOSE 4501
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/planner/main.mjs"]
