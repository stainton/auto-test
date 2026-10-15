ARG BROWSER_BASE
FROM ${BROWSER_BASE}
WORKDIR /app
COPY build/executor/package.json build/executor/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --no-audit --no-fund \
    && node -e "require('node:fs').accessSync(require('playwright').chromium.executablePath())" \
    && mkdir -p /var/lib/executor
COPY server ./server
COPY build/planner/setting*.json /tmp/planner-settings/
COPY build/planner/install-settings.mjs ./build/planner/install-settings.mjs
RUN node build/planner/install-settings.mjs /tmp/planner-settings /app/config/claude/settings.json \
    && rm -rf /tmp/planner-settings /app/build
ENV NODE_ENV=production PATH=/app/node_modules/.bin:$PATH PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright CLAUDE_CONFIG_DIR=/tmp/executor-claude EXECUTOR_CLAUDE_SETTINGS=/app/config/claude/settings.json EXECUTOR_HOST=0.0.0.0 EXECUTOR_PORT=4504 EXECUTOR_DATA_DIR=/var/lib/executor
EXPOSE 4504
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/executor/main.mjs"]
