import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const codingAgent = join(globalRoot, "@earendil-works", "pi-coding-agent");
if (!existsSync(codingAgent)) {
	throw new Error(`Could not find @earendil-works/pi-coding-agent under ${globalRoot}`);
}

const links = new Map([
	[join("node_modules", "@earendil-works", "pi-coding-agent"), codingAgent],
	[
		join("node_modules", "@earendil-works", "pi-ai"),
		join(codingAgent, "node_modules", "@earendil-works", "pi-ai"),
	],
	[join("node_modules", "typebox"), join(codingAgent, "node_modules", "typebox")],
]);

for (const [link, target] of links) {
	if (!existsSync(target)) throw new Error(`Missing Pi host dependency: ${target}`);
	mkdirSync(dirname(link), { recursive: true });
	if (existsSync(link) || lstatExists(link)) rmSync(link, { recursive: true, force: true });
	symlinkSync(target, link, "dir");
}

function lstatExists(path) {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}
