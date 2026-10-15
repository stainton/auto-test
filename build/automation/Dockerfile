ARG BROWSER_BASE
FROM ${BROWSER_BASE}
WORKDIR /app
COPY build/planner/package.json build/planner/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && rm -rf /root/.npm \
    && node -e "require('node:fs').accessSync(require('playwright').chromium.executablePath())" \
    && mkdir -p /var/lib/automation
COPY server ./server
COPY build/automation/setting*.json /tmp/automation-settings/
COPY build/planner/install-settings.mjs ./build/planner/install-settings.mjs
RUN node build/planner/install-settings.mjs /tmp/automation-settings /app/config/claude/settings.json \
    && rm -rf /tmp/automation-settings /app/build
ENV NODE_ENV=production PATH=/app/node_modules/.bin:$PATH PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright CLAUDE_CONFIG_DIR=/tmp/automation-claude PLANNER_CLAUDE_SETTINGS=/app/config/claude/settings.json GENERATOR_CLAUDE_SETTINGS=/app/config/claude/settings.json AUTOMATION_HOST=0.0.0.0 AUTOMATION_PORT=4501 AUTOMATION_DATA_DIR=/var/lib/automation
EXPOSE 4501
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/automation/main.mjs"]
