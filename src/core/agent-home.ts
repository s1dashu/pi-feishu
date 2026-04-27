import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const ENV_LINE_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** Fullwidth tilde (IME) → ASCII so `～/.foo` behaves like `~/.foo`. */
function normalizeTildeChars(input: string): string {
	return input.replace(/\uFF5E/g, "~");
}

/** Default agent data root when `PI_FEISHU_HOME` is unset: `~/.pi-feishu`. */
export function getDefaultAgentHomeDir(): string {
	return resolve(join(homedir(), ".pi-feishu"));
}

/** Resolved agent home; prefers `PI_FEISHU_HOME` after `loadAgentEnvIntoProcess()`. */
export function resolveAgentHomeDir(): string {
	const raw = process.env.PI_FEISHU_HOME?.trim();
	return raw ? expandUserHomePath(raw) : getDefaultAgentHomeDir();
}

/**
 * Show a path as `~/...` when it lies under the current user's home directory (prompts / logs).
 */
export function shortenHomeInPath(absolutePath: string): string {
	const abs = resolve(normalizeTildeChars(absolutePath));
	const home = resolve(homedir());
	if (abs === home) {
		return "~";
	}
	const prefix = home.endsWith(sep) ? home : `${home}${sep}`;
	if (abs.startsWith(prefix)) {
		const rest = abs.slice(prefix.length);
		return `~/${rest.split(sep).join("/")}`;
	}
	return abs;
}

/**
 * Resolve a user-typed path; expands leading `~/` (or `~\` on Windows) to the real home directory.
 */
export function expandUserHomePath(input: string): string {
	const trimmed = normalizeTildeChars(input).trim();
	if (!trimmed) {
		return "";
	}
	if (trimmed === "~") {
		return resolve(homedir());
	}
	if (trimmed.startsWith("~/")) {
		return resolve(join(homedir(), trimmed.slice(2)));
	}
	if (trimmed.startsWith("~\\")) {
		return resolve(join(homedir(), trimmed.slice(2)));
	}
	return resolve(trimmed);
}

/**
 * Shell snippet to set `PI_FEISHU_HOME` without embedding the OS username: uses `$HOME/...` when possible.
 */
export function shellExportPiFeishuHome(absolutePath: string): string {
	const abs = resolve(normalizeTildeChars(absolutePath));
	const home = resolve(homedir());
	const prefix = home.endsWith(sep) ? home : `${home}${sep}`;
	if (abs === home) {
		return 'export PI_FEISHU_HOME="$HOME"';
	}
	if (abs.startsWith(prefix)) {
		const rel = relative(home, abs);
		if (!rel || rel.startsWith("..")) {
			return `export PI_FEISHU_HOME=${JSON.stringify(abs)}`;
		}
		return `export PI_FEISHU_HOME="$HOME/${rel.split(sep).join("/")}"`;
	}
	return `export PI_FEISHU_HOME=${JSON.stringify(abs)}`;
}

export function getAgentEnvFilePath(homeDir: string = resolveAgentHomeDir()): string {
	return join(homeDir, ".env");
}

function decodeEnvValue(rawValue: string): string {
	const trimmed = rawValue.trim();
	if (!trimmed) {
		return "";
	}
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		try {
			return JSON.parse(trimmed) as string;
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

export function readAgentEnvFile(filePath: string): Record<string, string> {
	if (!existsSync(filePath)) {
		return {};
	}
	const text = readFileSync(filePath, "utf8");
	const result: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}
		const match = ENV_LINE_RE.exec(trimmed);
		if (!match) {
			continue;
		}
		result[match[1]!] = decodeEnvValue(match[2] ?? "");
	}
	return result;
}

export interface LoadAgentEnvOptions {
	/** If set (e.g. from `--home`), wins for reading `.env` and becomes `PI_FEISHU_HOME`. */
	agentHome?: string;
}

/**
 * Loads `<agentHome>/.env` into `process.env` (does not override existing vars),
 * then normalizes `PI_FEISHU_HOME` to an absolute path for child processes.
 */
export function loadAgentEnvIntoProcess(options?: LoadAgentEnvOptions): Record<string, string> {
	if (options?.agentHome) {
		process.env.PI_FEISHU_HOME = expandUserHomePath(options.agentHome);
	}

	const preliminary = process.env.PI_FEISHU_HOME?.trim()
		? expandUserHomePath(process.env.PI_FEISHU_HOME.trim())
		: getDefaultAgentHomeDir();

	const loaded = readAgentEnvFile(join(preliminary, ".env"));
	for (const [key, value] of Object.entries(loaded)) {
		if (!process.env[key]) {
			process.env[key] = value;
		}
	}

	const finalHome = process.env.PI_FEISHU_HOME?.trim()
		? expandUserHomePath(process.env.PI_FEISHU_HOME.trim())
		: preliminary;
	process.env.PI_FEISHU_HOME = finalHome;
	return loaded;
}

export function upsertAgentEnv(updates: Record<string, string | undefined>, homeDir?: string): void {
	const root = homeDir ?? resolveAgentHomeDir();
	const envPath = getAgentEnvFilePath(root);
	const current = readAgentEnvFile(envPath);
	for (const [key, value] of Object.entries(updates)) {
		if (value == null || value === "") {
			delete current[key];
			continue;
		}
		current[key] = value;
	}
	mkdirSync(dirname(envPath), { recursive: true });
	const body = Object.entries(current)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
		.join("\n");
	writeFileSync(envPath, body ? `${body}\n` : "", "utf8");
	try {
		chmodSync(envPath, 0o600);
	} catch {
		// Best-effort only; unsupported on some filesystems.
	}
}
