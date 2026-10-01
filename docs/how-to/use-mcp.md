# Use MCP and browser agents

Connect an MCP client or browser agent.

<!-- START doctoc -->
## Table of contents

- [Connect an MCP client](#connect-an-mcp-client)
- [Use a browser agent](#use-a-browser-agent)

<!-- END doctoc -->

## Connect an MCP client

1. Add `https://rom-weaver.com/mcp` in your client's MCP settings.
2. Select **Streamable HTTP**. No authentication is required.
3. Ask for supported formats or documentation.

Check for `search_docs` and `get_supported_formats`. This endpoint cannot access files or run workflows.

Self-hosted endpoints need Cloudflare Pages functions. Static and Docker deployments lack `/mcp`; see [webapp integration](../hosting/webapp-integration.md).

## Use a browser agent

Use a WebMCP-capable browser and agent. Follow [Chrome's setup instructions](https://developer.chrome.com/docs/ai/webmcp).

1. Open [rom-weaver](https://rom-weaver.com/) in the agent's browser.
2. Ask for a workflow. Wait for its form.
3. Select files yourself. Agents cannot set file fields.
4. Ask for configuration and an action request.
5. Check the dialog. Select **Approve action** or **Cancel**. Keep the tab open and check the result.

For Checksum, ask: “Enable SHA-256 and request checksum calculation.”

Agents need the current `get_workflow_state` revision. Refresh after each change or stale-state error.

For missing tools, check WebMCP support and the tab connection.
