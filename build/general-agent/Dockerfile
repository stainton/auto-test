FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2.1.236 \
    && apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    && mkdir -p /app/config/claude
COPY server ./server
COPY build/general-agent/setting*.json /tmp/general-agent-settings/
COPY build/planner/install-settings.mjs ./build/planner/install-settings.mjs
RUN node build/planner/install-settings.mjs /tmp/general-agent-settings /app/config/claude/settings.json \
    && rm -rf /tmp/general-agent-settings /app/build
ENV NODE_ENV=production CLAUDE_CONFIG_DIR=/tmp/general-agent-claude GENERAL_AGENT_CLAUDE_SETTINGS=/app/config/claude/settings.json GENERAL_AGENT_HOST=0.0.0.0 GENERAL_AGENT_PORT=4503
EXPOSE 4503
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/general-agent/main.mjs"]
