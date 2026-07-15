import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "typebox";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

type McpServer = {
	name: string;
	command: string;
	args?: string[];
	enabled?: boolean;
};

const configPath = join(homedir(), ".pi", "agent", "mcp.json");

function validServer(value: unknown): value is McpServer {
	return !!value && typeof value === "object" &&
		typeof (value as McpServer).name === "string" &&
		typeof (value as McpServer).command === "string";
}

async function loadServers(): Promise<McpServer[]> {
	try {
		const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
		if (!Array.isArray(parsed)) throw new Error("the root value must be an array");
		return parsed.filter(validServer);
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new Error(`Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function saveServers(servers: McpServer[]): Promise<void> {
	await mkdir(dirname(configPath), { recursive: true });
	const temporary = `${configPath}.tmp`;
	await writeFile(temporary, JSON.stringify(servers, null, 2) + "\n", "utf8");
	await rename(temporary, configPath);
}

function toolName(server: string, tool: string): string {
	return `mcp_${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export default function (pi: ExtensionAPI) {
	const clients: Client[] = [];

	pi.on("session_start", async (_event, ctx) => {
		let servers: McpServer[];
		try {
			servers = await loadServers();
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}

		for (const server of servers.filter((server) => server.enabled !== false)) {
			try {
				const client = new Client({ name: `pi-mcp-${server.name}`, version: "1.0.0" }, { capabilities: {} });
				await client.connect(new StdioClientTransport({ command: server.command, args: server.args ?? [] }));
				clients.push(client);
				const { tools } = await client.listTools();

				for (const tool of tools) {
					pi.registerTool({
						name: toolName(server.name, tool.name),
						label: `MCP ${server.name}: ${tool.name}`,
						description: tool.description || `MCP tool ${tool.name} from ${server.name}`,
						promptSnippet: `MCP (${server.name}): ${tool.name}`,
						parameters: Type.Unsafe(tool.inputSchema ?? { type: "object", additionalProperties: true }),
						async execute(_id, params, signal) {
							const result = await client.callTool({ name: tool.name, arguments: params }, undefined, { signal });
							const truncated = truncateHead(JSON.stringify(result.content, null, 2), {
								maxBytes: DEFAULT_MAX_BYTES,
								maxLines: DEFAULT_MAX_LINES,
							});
							const text = truncated.content + (truncated.truncated ? "\n\n[MCP output truncated by Pi.]" : "");
							if (result.isError) throw new Error(text);
							return { content: [{ type: "text", text }], details: {} };
						},
					});
				}
				ctx.ui.notify(`MCP connected: ${server.name} (${tools.length} tools).`, "info");
			} catch (error) {
				ctx.ui.notify(`MCP ${server.name} unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}
	});

	pi.on("session_shutdown", async () => {
		await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
	});

	pi.registerCommand("mcp", {
		description: "Manage MCP servers: /mcp [list|add|remove|enable|disable|reconnect]",
		handler: async (args, ctx) => {
			const [action = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			let servers = await loadServers();

			const reload = async () => {
				await ctx.reload();
			};
			const list = () => ctx.ui.notify(
				servers.length
					? servers.map((s) => `${s.enabled === false ? "off" : "on"}  ${s.name}: ${s.command} ${(s.args ?? []).join(" ")}`).join("\n")
					: "No MCP servers configured. Use /mcp add.",
				"info",
			);
			const add = async (name?: string, command?: string, commandArgs: string[] = []) => {
				const serverName = name ?? await ctx.ui.input("MCP server name:", "e.g. context7");
				if (!serverName) return;
				const executable = command ?? await ctx.ui.input("Command:", "e.g. npx");
				if (!executable) return;
				const argumentsText = command ? commandArgs.join(" ") : await ctx.ui.input("Arguments (space-separated):", "");
				if (servers.some((server) => server.name === serverName)) {
					ctx.ui.notify(`An MCP server named ${serverName} already exists.`, "error");
					return;
				}
				servers.push({ name: serverName, command: executable, args: argumentsText ? argumentsText.split(/\s+/) : [], enabled: true });
				await saveServers(servers);
				await reload();
			};
			const setEnabled = async (name: string | undefined, enabled: boolean) => {
				const selected = name ?? await ctx.ui.select(`Select MCP server to ${enabled ? "enable" : "disable"}:`, servers.map((s) => s.name));
				if (!selected) return;
				const server = servers.find((item) => item.name === selected);
				if (!server) return ctx.ui.notify(`Unknown MCP server: ${selected}`, "error");
				server.enabled = enabled;
				await saveServers(servers);
				await reload();
			};
			const remove = async (name?: string) => {
				const selected = name ?? await ctx.ui.select("Remove MCP server:", servers.map((s) => s.name));
				if (!selected) return;
				if (!servers.some((server) => server.name === selected)) return ctx.ui.notify(`Unknown MCP server: ${selected}`, "error");
				servers = servers.filter((server) => server.name !== selected);
				await saveServers(servers);
				await reload();
			};

			if (action === "list") return list();
			if (action === "add") return add(rest[0], rest[1], rest.slice(2));
			if (action === "remove") return remove(rest[0]);
			if (action === "enable") return setEnabled(rest[0], true);
			if (action === "disable") return setEnabled(rest[0], false);
			if (action === "reconnect") return reload();
			if (action) return ctx.ui.notify("Usage: /mcp [list|add|remove|enable|disable|reconnect]", "error");

			const choice = await ctx.ui.select("MCP servers", ["List servers", "Add server", "Enable server", "Disable server", "Remove server", "Reconnect enabled servers"]);
			if (choice === "List servers") return list();
			if (choice === "Add server") return add();
			if (choice === "Enable server") return setEnabled(undefined, true);
			if (choice === "Disable server") return setEnabled(undefined, false);
			if (choice === "Remove server") return remove();
			if (choice === "Reconnect enabled servers") return reload();
		},
	});
}
