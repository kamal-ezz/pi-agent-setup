import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Implementation, ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	getAgentDir,
	truncateHead,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	MCP_INVENTORY_ENTRY,
	authStatusForConfig,
	describeTransport,
	formatInventory,
	mcpToolName,
	parseMcpServers,
	type McpInventorySnapshot,
	type McpResourceInfo,
	type McpResourceTemplateInfo,
	type McpServerConfig,
	type McpServerSnapshot,
	type McpToolInfo,
} from "./inventory.ts";

const configPath = join(getAgentDir(), "mcp.json");
const CLIENT_NAME = "pi-mcp";
const CLIENT_VERSION = "2.0.0";
const MAX_PAGES = 1_000;
const MAX_INVENTORY_ITEMS = 1_000;
const MAX_INVENTORY_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_SCHEMA_BYTES = 128 * 1024;
const MAX_TOOL_DESCRIPTION_CHARS = 4_000;
const MAX_DIAGNOSTIC_CHARS = 2_000;

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type ListedResource = Awaited<ReturnType<Client["listResources"]>>["resources"][number];
type ListedResourceTemplate = Awaited<ReturnType<Client["listResourceTemplates"]>>["resourceTemplates"][number];

type RuntimeStatus = "disabled" | "starting" | "ready" | "failed";

interface McpRuntime {
	config: McpServerConfig;
	status: RuntimeStatus;
	client?: Client;
	serverInfo?: Implementation;
	capabilities?: ServerCapabilities;
	tools: ListedTool[];
	resources: ListedResource[];
	resourceTemplates: ListedResourceTemplate[];
	diagnostics: string[];
	lastRefreshedAt?: number;
	stderrTail?: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function addDiagnostic(runtime: McpRuntime, message: string): void {
	const normalized = message.trim().slice(-MAX_DIAGNOSTIC_CHARS);
	if (!normalized || runtime.diagnostics.includes(normalized)) return;
	runtime.diagnostics.push(normalized);
	if (runtime.diagnostics.length > 5) runtime.diagnostics.shift();
}

async function loadServers(): Promise<McpServerConfig[]> {
	try {
		return parseMcpServers(JSON.parse(await readFile(configPath, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new Error(`Could not read ${configPath}: ${errorMessage(error)}`);
	}
}

async function saveServers(servers: McpServerConfig[]): Promise<void> {
	// Validate the exact serialized shape before replacing the live config.
	parseMcpServers(servers);
	await mkdir(dirname(configPath), { recursive: true });
	const temporary = `${configPath}.tmp`;
	await writeFile(temporary, `${JSON.stringify(servers, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, configPath);
	await chmod(configPath, 0o600);
}

function environmentNames(config: McpServerConfig): string[] {
	if (config.transport === "stdio") return config.envVars ?? [];
	return [
		...(config.bearerTokenEnvVar ? [config.bearerTokenEnvVar] : []),
		...Object.values(config.envHeaders ?? {}),
	];
}

function parseNameList(value: string | undefined): string[] {
	return [...new Set((value ?? "").split(/[\s,]+/).map((name) => name.trim()).filter(Boolean))];
}

async function withTimeout<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	label: string,
	outerSignal?: AbortSignal,
): Promise<T> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
	try {
		return await operation(signal);
	} catch (error) {
		if (timedOut) throw new Error(`${label} timed out after ${timeoutMs}ms`);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

async function collectPages<T>(
	fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
): Promise<T[]> {
	const items: T[] = [];
	let encodedBytes = 0;
	let cursor: string | undefined;
	const seen = new Set<string>();
	for (let page = 0; page < MAX_PAGES; page++) {
		const result = await fetchPage(cursor);
		encodedBytes += Buffer.byteLength(JSON.stringify(result.items), "utf8");
		if (encodedBytes > MAX_INVENTORY_BYTES) {
			throw new Error(`MCP inventory exceeded ${MAX_INVENTORY_BYTES} encoded bytes`);
		}
		items.push(...result.items);
		if (items.length > MAX_INVENTORY_ITEMS) {
			throw new Error(`MCP inventory exceeded ${MAX_INVENTORY_ITEMS} items`);
		}
		if (!result.nextCursor) return items;
		if (seen.has(result.nextCursor)) throw new Error(`MCP pagination returned a repeated cursor: ${result.nextCursor}`);
		seen.add(result.nextCursor);
		cursor = result.nextCursor;
	}
	throw new Error(`MCP inventory exceeded ${MAX_PAGES} pages`);
}

async function listAllTools(client: Client, timeoutMs: number): Promise<ListedTool[]> {
	const tools = await collectPages(async (cursor) => {
		const result = await withTimeout(
			(signal) => client.listTools(cursor ? { cursor } : undefined, { signal }),
			timeoutMs,
			"MCP tools/list",
		);
		return { items: result.tools, nextCursor: result.nextCursor };
	});
	for (const tool of tools) {
		const schemaBytes = Buffer.byteLength(JSON.stringify(tool.inputSchema ?? {}), "utf8");
		if (schemaBytes > MAX_TOOL_SCHEMA_BYTES) {
			throw new Error(`MCP tool ${tool.name} schema exceeds ${MAX_TOOL_SCHEMA_BYTES} bytes`);
		}
		if (tool.description && tool.description.length > MAX_TOOL_DESCRIPTION_CHARS) {
			tool.description = `${tool.description.slice(0, MAX_TOOL_DESCRIPTION_CHARS - 1)}…`;
		}
	}
	return tools;
}

async function listAllResources(client: Client, timeoutMs: number): Promise<ListedResource[]> {
	return collectPages(async (cursor) => {
		const result = await withTimeout(
			(signal) => client.listResources(cursor ? { cursor } : undefined, { signal }),
			timeoutMs,
			"MCP resources/list",
		);
		return { items: result.resources, nextCursor: result.nextCursor };
	});
}

async function listAllResourceTemplates(client: Client, timeoutMs: number): Promise<ListedResourceTemplate[]> {
	return collectPages(async (cursor) => {
		const result = await withTimeout(
			(signal) => client.listResourceTemplates(cursor ? { cursor } : undefined, { signal }),
			timeoutMs,
			"MCP resources/templates/list",
		);
		return { items: result.resourceTemplates, nextCursor: result.nextCursor };
	});
}

function resolvedStdioEnvironment(config: Extract<McpServerConfig, { transport: "stdio" }>): Record<string, string> | undefined {
	if (!config.env && !config.envVars?.length) return undefined;
	const environment = { ...getDefaultEnvironment(), ...(config.env ?? {}) };
	for (const name of config.envVars ?? []) {
		const value = process.env[name];
		if (value === undefined) throw new Error(`Required environment variable ${name} is not set for MCP ${config.name}.`);
		environment[name] = value;
	}
	return environment;
}

function resolvedHttpHeaders(config: Extract<McpServerConfig, { transport: "http" }>): Record<string, string> {
	const headers = { ...(config.headers ?? {}) };
	for (const [name, environmentName] of Object.entries(config.envHeaders ?? {})) {
		const value = process.env[environmentName];
		if (value !== undefined) headers[name] = value;
	}
	if (config.bearerTokenEnvVar) {
		const token = process.env[config.bearerTokenEnvVar];
		if (token) headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

function createTransport(config: McpServerConfig, cwd: string, runtime: McpRuntime): Transport {
	if (config.transport === "http") {
		return new StreamableHTTPClientTransport(new URL(config.url), {
			// Never forward configured credentials through an HTTP redirect. Node's
			// fetch can preserve custom auth headers across origin/scheme changes.
			requestInit: { headers: resolvedHttpHeaders(config), redirect: "error" },
		});
	}
	const transport = new StdioClientTransport({
		command: config.command,
		args: config.args,
		env: resolvedStdioEnvironment(config),
		cwd: config.cwd ? (isAbsolute(config.cwd) ? config.cwd : resolve(cwd, config.cwd)) : undefined,
		stderr: "pipe",
	});
	transport.stderr?.on("data", (chunk) => {
		runtime.stderrTail = `${runtime.stderrTail ?? ""}${String(chunk)}`.slice(-MAX_DIAGNOSTIC_CHARS);
	});
	return transport;
}

function toolPayload(result: Awaited<ReturnType<Client["callTool"]>>): string {
	if ("toolResult" in result) return JSON.stringify(result.toolResult, null, 2);
	const payload: Record<string, unknown> = { content: result.content };
	if (result.structuredContent !== undefined) payload.structuredContent = result.structuredContent;
	return JSON.stringify(payload, null, 2);
}

function snapshotFor(runtime: McpRuntime): McpServerSnapshot {
	const tools: McpToolInfo[] = runtime.tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
	}));
	const resources: McpResourceInfo[] = runtime.resources.map((resource) => ({
		name: resource.name,
		title: resource.title,
		uri: resource.uri,
	}));
	const resourceTemplates: McpResourceTemplateInfo[] = runtime.resourceTemplates.map((template) => ({
		name: template.name,
		title: template.title,
		uriTemplate: template.uriTemplate,
	}));
	return {
		name: runtime.config.name,
		status: runtime.status,
		authStatus: authStatusForConfig(runtime.config),
		serverName: runtime.serverInfo?.name,
		serverVersion: runtime.serverInfo?.version,
		transport: describeTransport(runtime.config),
		tools,
		resources,
		resourceTemplates,
		diagnostics: [...runtime.diagnostics],
		lastRefreshedAt: runtime.lastRefreshedAt,
	};
}

export default function mcpExtension(pi: ExtensionAPI): void {
	const runtimes = new Map<string, McpRuntime>();
	const registeredToolNames = new Set<string>();
	let runtimeActive = false;
	let shuttingDown = false;
	let configError: string | undefined;

	function registerRuntimeTools(runtime: McpRuntime): void {
		for (const tool of runtime.tools) {
			const exposedName = mcpToolName(runtime.config.name, tool.name);
			if (registeredToolNames.has(exposedName)) continue;
			registeredToolNames.add(exposedName);
			const originalToolName = tool.name;
			pi.registerTool({
				name: exposedName,
				label: `MCP ${runtime.config.name}: ${originalToolName}`,
				description: tool.description || `MCP tool ${originalToolName} from ${runtime.config.name}`,
				promptSnippet: `MCP (${runtime.config.name}): ${originalToolName}`,
				parameters: Type.Unsafe(tool.inputSchema ?? { type: "object", additionalProperties: true }),
				async execute(_id, params, signal) {
					const current = runtimes.get(runtime.config.name);
					if (!current?.client || current.status !== "ready") {
						throw new Error(`MCP server ${runtime.config.name} is not connected.`);
					}
					if (!current.tools.some((candidate) => candidate.name === originalToolName)) {
						throw new Error(`MCP tool ${originalToolName} is no longer advertised by ${runtime.config.name}.`);
					}
					const result = await withTimeout(
						(requestSignal) => current.client!.callTool(
							{ name: originalToolName, arguments: params as Record<string, unknown> },
							undefined,
							{ signal: requestSignal },
						),
						current.config.requestTimeoutMs,
						`MCP ${runtime.config.name}/${originalToolName}`,
						signal,
					);
					const output = toolPayload(result);
					const truncated = truncateHead(output, {
						maxBytes: DEFAULT_MAX_BYTES,
						maxLines: DEFAULT_MAX_LINES,
					});
					const text = truncated.content + (truncated.truncated ? "\n\n[MCP output truncated by Pi.]" : "");
					if (!("toolResult" in result) && result.isError) throw new Error(text);
					return {
						content: [{ type: "text" as const, text }],
						details: { server: runtime.config.name, tool: originalToolName },
					};
				},
			});
		}
	}

	async function refreshRuntime(runtime: McpRuntime, verbose: boolean): Promise<void> {
		if (!runtime.client || runtime.status !== "ready") return;
		try {
			if (runtime.capabilities?.tools) {
				runtime.tools = await listAllTools(runtime.client, runtime.config.requestTimeoutMs);
				registerRuntimeTools(runtime);
			}
		} catch (error) {
			addDiagnostic(runtime, `Could not refresh tools: ${errorMessage(error)}`);
		}
		if (verbose && runtime.capabilities?.resources) {
			const [resources, templates] = await Promise.allSettled([
				listAllResources(runtime.client, runtime.config.requestTimeoutMs),
				listAllResourceTemplates(runtime.client, runtime.config.requestTimeoutMs),
			]);
			if (resources.status === "fulfilled") runtime.resources = resources.value;
			else addDiagnostic(runtime, `Could not list resources: ${errorMessage(resources.reason)}`);
			if (templates.status === "fulfilled") runtime.resourceTemplates = templates.value;
			else addDiagnostic(runtime, `Could not list resource templates: ${errorMessage(templates.reason)}`);
		}
		runtime.lastRefreshedAt = Date.now();
	}

	async function connectRuntime(runtime: McpRuntime, ctx: ExtensionContext): Promise<void> {
		if (!runtime.config.enabled) return;
		runtime.status = "starting";
		const client = new Client({ name: `${CLIENT_NAME}-${runtime.config.name}`, version: CLIENT_VERSION }, { capabilities: {} });
		runtime.client = client;
		client.onerror = (error) => addDiagnostic(runtime, error.message);
		client.onclose = () => {
			if (!shuttingDown && runtimeActive && runtime.status === "ready") {
				runtime.status = "failed";
				addDiagnostic(runtime, "Connection closed.");
			}
		};
		try {
			const transport = createTransport(runtime.config, ctx.cwd, runtime);
			await withTimeout(
				(signal) => client.connect(transport, { signal }),
				runtime.config.startupTimeoutMs,
				`MCP ${runtime.config.name} startup`,
			);
			runtime.serverInfo = client.getServerVersion();
			runtime.capabilities = client.getServerCapabilities();
			if (runtime.capabilities?.tools) runtime.tools = await listAllTools(client, runtime.config.requestTimeoutMs);
			runtime.status = "ready";
			runtime.lastRefreshedAt = Date.now();
			registerRuntimeTools(runtime);
		} catch (error) {
			runtime.status = "failed";
			addDiagnostic(runtime, errorMessage(error));
			if (runtime.stderrTail?.trim()) {
				addDiagnostic(runtime, "Server stderr was suppressed because it may contain credentials.");
			}
			await client.close().catch(() => {});
			runtime.client = undefined;
		}
	}

	function makeSnapshot(verbose: boolean): McpInventorySnapshot {
		return {
			version: 1,
			verbose,
			generatedAt: Date.now(),
			configPath,
			servers: [...runtimes.values()].map(snapshotFor),
			configError,
		};
	}

	async function saveAndApply(servers: McpServerConfig[], ctx: ExtensionCommandContext): Promise<void> {
		await saveServers(servers);
		const missing = [...new Set(
			servers
				.filter((server) => server.enabled)
				.flatMap(environmentNames)
				.filter((name) => process.env[name] === undefined),
		)];
		if (missing.length > 0) {
			ctx.ui.notify(
				`MCP configuration saved securely to ${configPath}.\n\nSet these variables before restarting Pi:\n${missing.map((name) => `export ${name}='your-secret'`).join("\n")}`,
				"warning",
			);
			return;
		}
		ctx.ui.notify("MCP configuration saved. Reconnecting…", "info");
		await ctx.reload();
	}

	async function configureHttpAuthentication(
		server: Extract<McpServerConfig, { transport: "http" }>,
		ctx: ExtensionCommandContext,
	): Promise<boolean> {
		const choice = await ctx.ui.select("HTTP authentication", [
			"None",
			"Bearer token from environment variable",
			"Custom header from environment variable",
		]);
		if (!choice) return false;
		server.headers = undefined;
		server.envHeaders = undefined;
		server.bearerTokenEnvVar = undefined;
		if (choice === "Bearer token from environment variable") {
			const name = await ctx.ui.input("Token environment variable", "e.g. REMOTE_MCP_TOKEN");
			if (!name?.trim()) return false;
			server.bearerTokenEnvVar = name.trim();
		}
		if (choice === "Custom header from environment variable") {
			const header = await ctx.ui.input("HTTP header name", "e.g. X-API-Key");
			if (!header?.trim()) return false;
			const name = await ctx.ui.input("Credential environment variable", "e.g. REMOTE_MCP_API_KEY");
			if (!name?.trim()) return false;
			server.envHeaders = { [header.trim()]: name.trim() };
		}
		return true;
	}

	async function runSetupWizard(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify(`Interactive setup requires TUI or RPC mode. Edit ${configPath} directly.`, "error");
			return;
		}
		let servers: McpServerConfig[];
		try {
			servers = await loadServers();
		} catch (error) {
			ctx.ui.notify(errorMessage(error), "error");
			return;
		}
		const actions = [
			"Add local stdio server",
			"Add remote HTTP server",
			"Configure authentication",
			"Enable or disable server",
			"Remove server",
			"Edit raw JSON",
			"Reconnect servers",
		];
		const action = await ctx.ui.select("MCP setup", actions);
		if (!action) return;

		if (action === "Add local stdio server") {
			const name = await ctx.ui.input("Server name", "e.g. context7");
			if (!name?.trim()) return;
			const command = await ctx.ui.input("Executable", "e.g. npx");
			if (!command?.trim()) return;
			const argumentText = await ctx.ui.editor("Arguments — one argument per line", "-y\n@example/mcp-server");
			if (argumentText === undefined) return;
			const credentials = await ctx.ui.input(
				"Credential environment variables (optional, comma-separated)",
				"e.g. GITHUB_PERSONAL_ACCESS_TOKEN",
			);
			try {
				servers = parseMcpServers([
					...servers,
					{
						name: name.trim(),
						transport: "stdio",
						command: command.trim(),
						args: argumentText.split("\n").map((argument) => argument.trim()).filter(Boolean),
						envVars: parseNameList(credentials),
						enabled: true,
					},
				]);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}
			await saveAndApply(servers, ctx);
			return;
		}

		if (action === "Add remote HTTP server") {
			const name = await ctx.ui.input("Server name", "e.g. remote");
			if (!name?.trim()) return;
			const url = await ctx.ui.input("Streamable HTTP MCP URL", "https://example.com/mcp");
			if (!url?.trim()) return;
			let candidate: McpServerConfig;
			try {
				[candidate] = parseMcpServers([{ name: name.trim(), transport: "http", url: url.trim(), enabled: true }]);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}
			if (!candidate || candidate.transport !== "http") return;
			if (!await configureHttpAuthentication(candidate, ctx)) return;
			try {
				servers = parseMcpServers([...servers, candidate]);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}
			await saveAndApply(servers, ctx);
			return;
		}

		if (action === "Configure authentication") {
			if (servers.length === 0) return ctx.ui.notify("No MCP servers configured.", "warning");
			const selected = await ctx.ui.select("Choose server", servers.map((server) => server.name));
			const index = servers.findIndex((server) => server.name === selected);
			if (index < 0) return;
			const server = structuredClone(servers[index]!);
			if (server.transport === "stdio") {
				const names = await ctx.ui.input(
					"Credential environment variables (comma-separated)",
					server.envVars?.join(", ") || "e.g. GITHUB_PERSONAL_ACCESS_TOKEN",
				);
				if (names === undefined) return;
				server.envVars = parseNameList(names);
			} else if (!await configureHttpAuthentication(server, ctx)) {
				return;
			}
			servers[index] = server;
			await saveAndApply(parseMcpServers(servers), ctx);
			return;
		}

		if (action === "Enable or disable server") {
			if (servers.length === 0) return ctx.ui.notify("No MCP servers configured.", "warning");
			const selected = await ctx.ui.select(
				"Toggle MCP server",
				servers.map((server) => `${server.enabled ? "on" : "off"}  ${server.name}`),
			);
			if (!selected) return;
			const name = selected.replace(/^(?:on|off)\s+/, "");
			const server = servers.find((candidate) => candidate.name === name);
			if (!server) return;
			server.enabled = !server.enabled;
			await saveAndApply(parseMcpServers(servers), ctx);
			return;
		}

		if (action === "Remove server") {
			if (servers.length === 0) return ctx.ui.notify("No MCP servers configured.", "warning");
			const selected = await ctx.ui.select("Remove MCP server", servers.map((server) => server.name));
			if (!selected) return;
			if (!await ctx.ui.confirm("Remove MCP server?", selected)) return;
			await saveAndApply(servers.filter((server) => server.name !== selected), ctx);
			return;
		}

		if (action === "Edit raw JSON") {
			let current = "[]\n";
			try { current = await readFile(configPath, "utf8"); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const edited = await ctx.ui.editor(`Edit ${configPath}`, current);
			if (edited === undefined) return;
			try {
				servers = parseMcpServers(JSON.parse(edited));
			} catch (error) {
				ctx.ui.notify(`Invalid MCP configuration: ${errorMessage(error)}`, "error");
				return;
			}
			await saveAndApply(servers, ctx);
			return;
		}

		if (action === "Reconnect servers") {
			await ctx.reload();
		}
	}

	pi.registerEntryRenderer<McpInventorySnapshot>(MCP_INVENTORY_ENTRY, (entry, _options, theme) => {
		if (!entry.data) return new Text(theme.fg("error", "MCP inventory entry is missing data."), 0, 0);
		const lines = formatInventory(entry.data).split("\n");
		const styled = lines.map((line, index) => {
			if (index === 0) return theme.fg("accent", theme.bold(line));
			if (line.startsWith("Configuration error:") || line.includes(" (failed)")) return theme.fg("error", line);
			if (line.includes(" (disabled)")) return theme.fg("dim", line);
			if (line.startsWith("• ")) return theme.bold(line);
			if (line.trimStart().startsWith("Diagnostic:")) return theme.fg("warning", line);
			return line;
		});
		return new Text(styled.join("\n"), 0, 0);
	});

	pi.registerCommand("mcp", {
		description: "List live MCP tools; use /mcp verbose for resources and diagnostics",
		getArgumentCompletions: (prefix) => "verbose".startsWith(prefix) ? [{ value: "verbose", label: "verbose", description: "Include resources and diagnostics" }] : null,
		handler: async (args, ctx) => {
			const argument = args.trim().toLowerCase();
			if (argument && argument !== "verbose") {
				ctx.ui.notify("Usage: /mcp [verbose]", "error");
				return;
			}
			const verbose = argument === "verbose";
			ctx.ui.setStatus("mcp-inventory", ctx.ui.theme.fg("accent", "Loading MCP inventory…"));
			try {
				await Promise.all([...runtimes.values()].map((runtime) => refreshRuntime(runtime, verbose)));
				const snapshot = makeSnapshot(verbose);
				pi.appendEntry(MCP_INVENTORY_ENTRY, snapshot);
				if (ctx.mode !== "tui") ctx.ui.notify(formatInventory(snapshot), configError ? "error" : "info");
			} finally {
				ctx.ui.setStatus("mcp-inventory", undefined);
			}
		},
	});

	pi.registerCommand("mcp-setup", {
		description: "Interactively add, authenticate, enable, or remove MCP servers",
		handler: async (_args, ctx) => runSetupWizard(ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		runtimeActive = true;
		shuttingDown = false;
		configError = undefined;
		runtimes.clear();
		registeredToolNames.clear();
		let servers: McpServerConfig[];
		try {
			servers = await loadServers();
		} catch (error) {
			configError = errorMessage(error);
			ctx.ui.notify(configError, "error");
			return;
		}

		for (const config of servers) {
			runtimes.set(config.name, {
				config,
				status: config.enabled ? "starting" : "disabled",
				tools: [],
				resources: [],
				resourceTemplates: [],
				diagnostics: [],
			});
		}
		const enabled = [...runtimes.values()].filter((runtime) => runtime.config.enabled);
		if (enabled.length === 0) return;
		let settled = 0;
		ctx.ui.setStatus("mcp-startup", ctx.ui.theme.fg("accent", `Starting MCP servers (0/${enabled.length})…`));
		await Promise.all(enabled.map(async (runtime) => {
			await connectRuntime(runtime, ctx);
			settled += 1;
			ctx.ui.setStatus("mcp-startup", ctx.ui.theme.fg("accent", `Starting MCP servers (${settled}/${enabled.length})…`));
		}));
		ctx.ui.setStatus("mcp-startup", undefined);
		const failed = enabled.filter((runtime) => runtime.status === "failed");
		if (failed.length > 0) {
			ctx.ui.notify(`MCP startup incomplete: ${failed.map((runtime) => runtime.config.name).join(", ")}`, "warning");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true;
		runtimeActive = false;
		ctx.ui.setStatus("mcp-startup", undefined);
		ctx.ui.setStatus("mcp-inventory", undefined);
		await Promise.all([...runtimes.values()].map(async (runtime) => {
			await runtime.client?.close().catch(() => {});
			runtime.client = undefined;
		}));
	});
}
