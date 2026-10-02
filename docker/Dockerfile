# Backend of the AI agent for reports published in Jenkins (`pw-extended-report ai-gateway`).
#
#   docker build -f docker/Dockerfile -t pw-agent .                       # from the repository root
#   docker build -f docker/Dockerfile --build-arg WITH_SERENA=1 --build-arg WITH_CODE_INDEX=1 -t pw-agent .
#
# Closed contour: point BASE_IMAGE to your registry mirror and NPM_REGISTRY / PIP_INDEX_URL to Nexus.
# The Playwright version of the base image should match the one your tests use (traces, locator lab).

ARG PLAYWRIGHT_VERSION=1.63.0
ARG BASE_IMAGE=mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

# ---------- build the package from source ----------
FROM ${BASE_IMAGE} AS build
ARG NPM_REGISTRY=
WORKDIR /src
COPY package.json package-lock.json ./
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi && npm ci --ignore-scripts
COPY . .
RUN npm run build && npm pack --pack-destination /tmp && mv /tmp/playwright-extended-report-*.tgz /tmp/package.tgz

# ---------- runtime ----------
FROM ${BASE_IMAGE}
ARG PLAYWRIGHT_VERSION
ARG NPM_REGISTRY=
ARG PIP_INDEX_URL=
# MCP servers baked into the image (each can also be added later via /config/mcp.json).
ARG WITH_PLAYWRIGHT_MCP=1
# Playwright MCP may use a newer Playwright than the tests: its Chromium is installed separately.
# In the closed contour set PLAYWRIGHT_DOWNLOAD_HOST to your mirror.
ARG PLAYWRIGHT_MCP_VERSION=latest
ARG PLAYWRIGHT_DOWNLOAD_HOST=
ARG WITH_CONTEXT7=0
ARG WITH_SERENA=0
ARG WITH_CODE_INDEX=0

ENV NODE_ENV=production \
    EXTENDED_REPORT_MCP_CONFIG=/config/mcp.json \
    AGENT_PORT=8787 \
    AGENT_REPO=/workspace

WORKDIR /opt/agent
COPY --from=build /tmp/package.tgz /tmp/package.tgz
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
 && if [ -n "$PLAYWRIGHT_DOWNLOAD_HOST" ]; then export PLAYWRIGHT_DOWNLOAD_HOST; fi \
 && echo '{"name":"pw-agent","private":true}' > package.json \
 && npm install --no-audit --no-fund /tmp/package.tgz "@playwright/test@${PLAYWRIGHT_VERSION}" \
 && if [ "$WITH_PLAYWRIGHT_MCP" = "1" ]; then npm install --no-audit --no-fund "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
      && CORE=$(ls -d node_modules/@playwright/mcp/node_modules/playwright-core 2>/dev/null || echo node_modules/playwright-core) \
      && node "$CORE/cli.js" install chromium; fi \
 && if [ "$WITH_CONTEXT7" = "1" ]; then npm install --no-audit --no-fund @upstash/context7-mcp; fi \
 && rm /tmp/package.tgz && npm cache clean --force
ENV PATH=/opt/agent/node_modules/.bin:$PATH

# Python-based MCP servers (serena, code-index) via uv.
RUN if [ "$WITH_SERENA" = "1" ] || [ "$WITH_CODE_INDEX" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends python3-pip pipx git && rm -rf /var/lib/apt/lists/* \
      && export PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin ${PIP_INDEX_URL:+PIP_INDEX_URL=$PIP_INDEX_URL} \
      && if [ "$WITH_SERENA" = "1" ]; then pipx install serena-agent || pipx install "git+https://github.com/oraios/serena"; fi \
      && if [ "$WITH_CODE_INDEX" = "1" ]; then pipx install code-index-mcp; fi; \
    fi

# Optional: a prebuilt codebase-memory-mcp binary can be mounted to /opt/mcp/codebase-memory-mcp.
RUN mkdir -p /config /opt/mcp /workspace
COPY docker/mcp.docker.json /config/mcp.default.json
COPY docker/entrypoint.sh /usr/local/bin/pw-agent-entrypoint
RUN chmod +x /usr/local/bin/pw-agent-entrypoint

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.AGENT_PORT||8787)+'/api/agent/status',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["pw-agent-entrypoint"]
