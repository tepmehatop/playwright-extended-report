#!/bin/sh
# Starts the agent backend. Configuration via environment (see docs/DEPLOYMENT.md):
#   EXTENDED_REPORT_AI_*, GIGACHAT_*, PROXY_*  - the model
#   AGENT_REPO          - mounted tests repository (sources for analysis, ${REPO} for MCP)
#   AGENT_ALLOW_RUN=1   - also allow re-runs and fixes in AGENT_REPO (off by default)
#   EXTENDED_REPORT_MCP_CONFIG - MCP servers, default /config/mcp.json (falls back to the built-in default)
set -e
if [ ! -f "$EXTENDED_REPORT_MCP_CONFIG" ] && [ -f /config/mcp.default.json ]; then
  export EXTENDED_REPORT_MCP_CONFIG=/config/mcp.default.json
fi
set -- --host 0.0.0.0 --port "${AGENT_PORT:-8787}" "$@"
if [ -d "$AGENT_REPO" ] && [ -n "$(ls -A "$AGENT_REPO" 2>/dev/null)" ]; then
  set -- "$@" --repo "$AGENT_REPO"
  if [ "$AGENT_ALLOW_RUN" = "1" ]; then
    set -- "$@" --allow-run
  fi
fi
exec pw-extended-report ai-gateway "$@"
