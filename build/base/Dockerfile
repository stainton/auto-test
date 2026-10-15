# Chromium + system libraries + tini, shared by the planner / generator / executor / automation images.
# Playwright's browser download (hundreds of MB) lives only here, so it is fetched once per Playwright
# version instead of once per service image, and a bump of another dependency never re-downloads it.
FROM node:24-bookworm-slim
ARG PLAYWRIGHT_VERSION
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN test -n "$PLAYWRIGHT_VERSION" \
    && apt-get update && apt-get install -y --no-install-recommends tini \
    && npx --yes playwright-core@${PLAYWRIGHT_VERSION} install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    && chmod -R a+rX /opt/ms-playwright
