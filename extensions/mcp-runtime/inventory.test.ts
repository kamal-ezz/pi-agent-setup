import assert from "node:assert/strict";
import test from "node:test";
import {
	authStatusForConfig,
	describeTransport,
	formatInventory,
	mcpToolName,
	parseMcpServers,
	type McpInventorySnapshot,
} from "./inventory.ts";

test("legacy stdio configuration remains supported", () => {
	const [server] = parseMcpServers([
		{ name: "context7", command: "npx", args: ["-y", "@upstash/context7-mcp"], envVars: ["CONTEXT7_API_KEY", "CONTEXT7_API_KEY"], enabled: true },
	]);
	assert.equal(server?.transport, "stdio");
	assert.equal(server?.startupTimeoutMs, 15_000);
	assert.equal(server?.requestTimeoutMs, 60_000);
	assert.deepEqual(server?.transport === "stdio" ? server.envVars : undefined, ["CONTEXT7_API_KEY"]);
	assert.equal(describeTransport(server!), "npx -y @upstash/context7-mcp");
	assert.equal(authStatusForConfig(server!), "unsupported");
});

test("stdio commands and environment names are normalized and validated", () => {
	const [server] = parseMcpServers([
		{ name: "local", command: "  npx  ", envVars: [" TOKEN "] },
	]);
	assert.equal(server?.transport === "stdio" ? server.command : undefined, "npx");
	assert.deepEqual(server?.transport === "stdio" ? server.envVars : undefined, ["TOKEN"]);
	assert.throws(
		() => parseMcpServers([{ name: "bad", command: "npx", envVars: ["BAD-NAME"] }]),
		/valid environment variable name/,
	);
	assert.throws(
		() => parseMcpServers([{ name: "bad", command: "npx", env: { "BAD=NAME": "value" } }]),
		/valid environment variable name/,
	);
});

test("credentialed HTTP requires TLS except on loopback", () => {
	assert.throws(
		() => parseMcpServers([
			{ name: "remote", transport: "http", url: "http://example.com/mcp", bearerTokenEnvVar: "MCP_TOKEN" },
		]),
		/must use https/,
	);
	assert.doesNotThrow(() => parseMcpServers([
		{ name: "local", transport: "http", url: "http://127.0.0.1:3000/mcp", bearerTokenEnvVar: "MCP_TOKEN" },
	]));
	assert.throws(
		() => parseMcpServers([
			{ name: "embedded", transport: "http", url: "https://user:pass@example.com/mcp" },
		]),
		/must not embed credentials/,
	);
});

test("HTTP configuration resolves auth status without exposing token values", () => {
	const [server] = parseMcpServers([
		{ name: "remote", transport: "http", url: "https://example.com/mcp?secret=yes", bearerTokenEnvVar: "MCP_TOKEN" },
	]);
	assert.equal(authStatusForConfig(server!, {}), "notLoggedIn");
	assert.equal(authStatusForConfig(server!, { MCP_TOKEN: "secret" }), "bearerToken");
	assert.equal(describeTransport(server!), "https://example.com/mcp");
});

test("transport descriptions redact secret command arguments", () => {
	const [server] = parseMcpServers([
		{ name: "local", command: "server", args: ["--api-key", "secret-value", "--token=also-secret", "safe"] },
	]);
	const description = describeTransport(server!);
	assert.doesNotMatch(description, /secret-value|also-secret/);
	assert.match(description, /<redacted>/);
	assert.match(description, /safe/);
});

test("server names that would collide as Pi tool prefixes are rejected", () => {
	assert.throws(
		() => parseMcpServers([
			{ name: "a.b", command: "one" },
			{ name: "a b", command: "two" },
		]),
		/collide/,
	);
	assert.equal(mcpToolName("a.b", "find/docs"), "mcp_a_b_find_docs");
});

test("default and verbose inventory match Codex-style detail levels", () => {
	const base: McpInventorySnapshot = {
		version: 1,
		verbose: false,
		generatedAt: 1,
		configPath: "/tmp/mcp.json",
		servers: [{
			name: "context7",
			status: "ready",
			authStatus: "unsupported",
			serverName: "Context7",
			serverVersion: "1.0.0",
			transport: "npx -y @upstash/context7-mcp",
			tools: [{ name: "query-docs", inputSchema: { type: "object" } }, { name: "resolve-library-id", inputSchema: { type: "object" } }],
			resources: [{ name: "docs", uri: "context7://docs" }],
			resourceTemplates: [{ name: "library", uriTemplate: "context7://{library}" }],
			diagnostics: [],
			lastRefreshedAt: 1,
		}],
	};
	const concise = formatInventory(base);
	assert.match(concise, /Auth: Unsupported/);
	assert.match(concise, /Tools: query-docs, resolve-library-id/);
	assert.doesNotMatch(concise, /Resources:|Transport:/);

	const verbose = formatInventory({ ...base, verbose: true });
	assert.match(verbose, /Server: Context7 1\.0\.0/);
	assert.match(verbose, /Transport:/);
	assert.match(verbose, /Resources: docs \(context7:\/\/docs\)/);
	assert.match(verbose, /Resource templates: library/);
});
