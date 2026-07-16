# Unified MCP for Pi

Codex-style MCP runtime and inventory command.

```text
/mcp          # live server auth and tool inventory
/mcp verbose  # add server version, transport, resources, templates, and diagnostics
/mcp-setup    # guided add/auth/enable/disable/remove setup
```

Use `/mcp-setup` for normal configuration. It validates and atomically saves `~/.pi/agent/mcp.json`, locks the file to mode `0600`, and reconnects automatically when required environment variables are already available. Raw JSON editing remains available as an advanced option.

## Stdio server

```json
{
  "name": "context7",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@upstash/context7-mcp"],
  "enabled": true
}
```

`transport` may be omitted for legacy stdio entries. Optional fields: `env`, `envVars`, `cwd`, `startupTimeoutMs`, and `requestTimeoutMs`.

For credentials, export the secret before starting Pi and list only its name:

```json
{
  "name": "private-server",
  "command": "npx",
  "args": ["-y", "@example/private-mcp"],
  "envVars": ["PRIVATE_MCP_API_KEY"]
}
```

`envVars` copies those named values from Pi's process environment. A missing required variable makes startup fail with a diagnostic instead of silently passing an empty credential.

## Streamable HTTP server

```json
{
  "name": "remote",
  "transport": "http",
  "url": "https://example.com/mcp",
  "bearerTokenEnvVar": "REMOTE_MCP_TOKEN",
  "enabled": true
}
```

HTTP also supports static `headers` and `envHeaders` (header name to environment-variable name). Header values and tokens are never shown by `/mcp verbose`.

The extension connects enabled servers concurrently, paginates inventory requests, preserves live tools, closes clients during session replacement, and caps startup and request times.
