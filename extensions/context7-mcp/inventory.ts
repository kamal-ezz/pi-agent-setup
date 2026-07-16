export const MCP_INVENTORY_ENTRY = "mcp-inventory-v1";
export const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export type McpAuthStatus = "unsupported" | "notLoggedIn" | "bearerToken" | "oauth";
export type McpRuntimeStatus = "disabled" | "starting" | "ready" | "failed";

interface McpServerBase {
	name: string;
	enabled: boolean;
	startupTimeoutMs: number;
	requestTimeoutMs: number;
}

export interface StdioMcpServerConfig extends McpServerBase {
	transport: "stdio";
	command: string;
	args: string[];
	env?: Record<string, string>;
	envVars?: string[];
	cwd?: string;
}

export interface HttpMcpServerConfig extends McpServerBase {
	transport: "http";
	url: string;
	headers?: Record<string, string>;
	envHeaders?: Record<string, string>;
	bearerTokenEnvVar?: string;
}

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

export interface McpResourceInfo {
	name: string;
	title?: string;
	uri: string;
}

export interface McpResourceTemplateInfo {
	name: string;
	title?: string;
	uriTemplate: string;
}

export interface McpServerSnapshot {
	name: string;
	status: McpRuntimeStatus;
	authStatus: McpAuthStatus;
	serverName?: string;
	serverVersion?: string;
	transport: string;
	tools: McpToolInfo[];
	resources: McpResourceInfo[];
	resourceTemplates: McpResourceTemplateInfo[];
	diagnostics: string[];
	lastRefreshedAt?: number;
}

export interface McpInventorySnapshot {
	version: 1;
	verbose: boolean;
	generatedAt: number;
	configPath: string;
	servers: McpServerSnapshot[];
	configError?: string;
}

function stringRecord(value: unknown, label: string): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object of string values`);
	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") throw new Error(`${label}.${key} must be a string`);
		result[key] = item;
	}
	return result;
}

function positiveTimeout(value: unknown, fallback: number, label: string): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || (value as number) < 100 || (value as number) > 600_000) {
		throw new Error(`${label} must be an integer from 100 to 600000 milliseconds`);
	}
	return value as number;
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value;
}

export function parseMcpServers(value: unknown): McpServerConfig[] {
	if (!Array.isArray(value)) throw new Error("the root value must be an array");
	const servers: McpServerConfig[] = [];
	const names = new Set<string>();
	const toolPrefixes = new Set<string>();

	for (let index = 0; index < value.length; index++) {
		const raw = value[index];
		const label = `server[${index}]`;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label} must be an object`);
		const item = raw as Record<string, unknown>;
		if (typeof item.name !== "string" || !item.name.trim()) throw new Error(`${label}.name must be a non-empty string`);
		const name = item.name.trim();
		if (names.has(name)) throw new Error(`duplicate MCP server name: ${name}`);
		names.add(name);
		const prefix = sanitizeToolPart(name);
		if (toolPrefixes.has(prefix)) throw new Error(`MCP server names collide after tool-name normalization: ${name}`);
		toolPrefixes.add(prefix);

		if (item.enabled !== undefined && typeof item.enabled !== "boolean") throw new Error(`${label}.enabled must be boolean`);
		const base: McpServerBase = {
			name,
			enabled: item.enabled !== false,
			startupTimeoutMs: positiveTimeout(item.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, `${label}.startupTimeoutMs`),
			requestTimeoutMs: positiveTimeout(item.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, `${label}.requestTimeoutMs`),
		};
		const transport = item.transport ?? (typeof item.url === "string" ? "http" : "stdio");
		if (transport === "stdio") {
			if (typeof item.command !== "string" || !item.command.trim()) throw new Error(`${label}.command must be a non-empty string`);
			if (item.args !== undefined && (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string"))) {
				throw new Error(`${label}.args must be an array of strings`);
			}
			if (
				item.envVars !== undefined &&
				(!Array.isArray(item.envVars) || item.envVars.some((name) => typeof name !== "string" || !name.trim()))
			) {
				throw new Error(`${label}.envVars must be an array of non-empty strings`);
			}
			servers.push({
				...base,
				transport: "stdio",
				command: item.command,
				args: (item.args as string[] | undefined) ?? [],
				env: stringRecord(item.env, `${label}.env`),
				envVars: item.envVars ? [...new Set(item.envVars as string[])] : undefined,
				cwd: optionalString(item.cwd, `${label}.cwd`),
			});
			continue;
		}
		if (transport === "http") {
			if (typeof item.url !== "string") throw new Error(`${label}.url must be a URL string`);
			let url: URL;
			try {
				url = new URL(item.url);
			} catch {
				throw new Error(`${label}.url is not a valid URL`);
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${label}.url must use http or https`);
			servers.push({
				...base,
				transport: "http",
				url: item.url,
				headers: stringRecord(item.headers, `${label}.headers`),
				envHeaders: stringRecord(item.envHeaders, `${label}.envHeaders`),
				bearerTokenEnvVar: optionalString(item.bearerTokenEnvVar, `${label}.bearerTokenEnvVar`),
			});
			continue;
		}
		throw new Error(`${label}.transport must be "stdio" or "http"`);
	}
	return servers;
}

export function sanitizeToolPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function mcpToolName(server: string, tool: string): string {
	return `mcp_${sanitizeToolPart(server)}_${sanitizeToolPart(tool)}`;
}

function redactArgument(arg: string, previous?: string): string {
	if (
		previous &&
		!previous.includes("=") &&
		/(?:token|secret|password|api[-_]?key|authorization)/i.test(previous)
	) return "<redacted>";
	if (/^(?:--?[^=]*(?:token|secret|password|api[-_]?key|authorization)[^=]*)=/i.test(arg)) {
		return `${arg.slice(0, arg.indexOf("=") + 1)}<redacted>`;
	}
	return arg;
}

function quoteArg(value: string): string {
	return /^[a-zA-Z0-9_./:@%+-]+$/.test(value) ? value : JSON.stringify(value);
}

export function describeTransport(config: McpServerConfig): string {
	if (config.transport === "stdio") {
		const args = config.args.map((arg, index) => redactArgument(arg, config.args[index - 1])).map(quoteArg);
		return [quoteArg(config.command), ...args].join(" ");
	}
	const url = new URL(config.url);
	url.username = "";
	url.password = "";
	url.search = "";
	url.hash = "";
	return url.toString();
}

export function authStatusForConfig(config: McpServerConfig, env: NodeJS.ProcessEnv = process.env): McpAuthStatus {
	if (config.transport === "stdio") return "unsupported";
	const staticAuthorization = Object.keys(config.headers ?? {}).some((name) => name.toLowerCase() === "authorization");
	if (staticAuthorization) return "bearerToken";
	if (config.bearerTokenEnvVar) return env[config.bearerTokenEnvVar] ? "bearerToken" : "notLoggedIn";
	const envAuthorization = Object.entries(config.envHeaders ?? {}).find(([name]) => name.toLowerCase() === "authorization");
	if (envAuthorization) return env[envAuthorization[1]] ? "bearerToken" : "notLoggedIn";
	return "unsupported";
}

export function authStatusLabel(status: McpAuthStatus): string {
	return {
		unsupported: "Unsupported",
		notLoggedIn: "Not logged in",
		bearerToken: "Bearer token",
		oauth: "OAuth",
	}[status];
}

export function runtimeStatusLabel(status: McpRuntimeStatus): string {
	return { disabled: "disabled", starting: "starting", ready: "ready", failed: "failed" }[status];
}

export function formatInventory(snapshot: McpInventorySnapshot): string {
	const lines = ["MCP Tools", ""];
	if (snapshot.configError) {
		lines.push(`Configuration error: ${snapshot.configError}`, `Config: ${snapshot.configPath}`);
		return lines.join("\n");
	}
	if (snapshot.servers.length === 0) {
		lines.push("• No MCP servers configured.", `  Config: ${snapshot.configPath}`);
		return lines.join("\n");
	}
	if (!snapshot.servers.some((server) => server.tools.length > 0)) lines.push("• No MCP tools available.", "");

	for (const server of [...snapshot.servers].sort((a, b) => a.name.localeCompare(b.name))) {
		const state = server.status === "ready" ? "" : ` (${runtimeStatusLabel(server.status)})`;
		lines.push(`• ${server.name}${state}`);
		lines.push(`  Auth: ${authStatusLabel(server.authStatus)}`);
		const tools = [...server.tools].map((tool) => tool.name).sort();
		lines.push(`  Tools: ${tools.length ? tools.join(", ") : "(none)"}`);
		if (snapshot.verbose) {
			if (server.serverName || server.serverVersion) {
				lines.push(`  Server: ${[server.serverName, server.serverVersion].filter(Boolean).join(" ")}`);
			}
			lines.push(`  Transport: ${server.transport}`);
			const resources = [...server.resources]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((resource) => `${resource.title ?? resource.name} (${resource.uri})`);
			lines.push(`  Resources: ${resources.length ? resources.join(", ") : "(none)"}`);
			const templates = [...server.resourceTemplates]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((template) => `${template.title ?? template.name} (${template.uriTemplate})`);
			lines.push(`  Resource templates: ${templates.length ? templates.join(", ") : "(none)"}`);
			if (server.lastRefreshedAt) lines.push(`  Refreshed: ${new Date(server.lastRefreshedAt).toISOString()}`);
		}
		const diagnostics = snapshot.verbose
			? server.diagnostics
			: server.status === "failed"
				? server.diagnostics.slice(-1)
				: [];
		for (const diagnostic of diagnostics) lines.push(`  Diagnostic: ${diagnostic}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
