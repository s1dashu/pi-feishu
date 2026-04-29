import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { join } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { loadAgentEnvIntoProcess, resolveAgentHomeDir } from "../../core/agent-home.js";
import { getStoredProfile, loadConfigStore, type PiFeishuConfigStore } from "../../core/config-store.js";
import type { LarkConfig } from "./platform/index.js";

/** Built-in tool names accepted by `createAgentSession({ tools })` (pi-coding-agent). */
type BuiltinToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

/** Default Feishu "coding" tool preset (name allowlist; includes grep/find/ls). */
const CODING_TOOL_NAMES: BuiltinToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const READONLY_TOOL_NAMES: BuiltinToolName[] = ["read", "grep", "find", "ls"];
const ALL_BUILTIN_TOOL_NAMES: BuiltinToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
const VALID_TOOL_NAMES = new Set<BuiltinToolName>(ALL_BUILTIN_TOOL_NAMES);

export interface FeishuBotConfig {
	homeDir: string;
	feishu: LarkConfig;
	model: Model<any>;
	modelLabel: string;
	thinkingLevel: ThinkingLevel;
	/** Tool name allowlist for `createAgentSession` (pi-coding-agent 0.70+). */
	tools: string[];
	toolLabel: string;
	runMode: "start" | "dev";
	debug: boolean;
	verboseLogs: boolean;
	resumeSessions: boolean;
	outputToolCallsToIm: boolean;
	startedAtMs: number;
}

function parseThinkingLevel(value: string | undefined): ThinkingLevel {
	if (!value) {
		return "off";
	}
	if (!VALID_THINKING_LEVELS.has(value as ThinkingLevel)) {
		throw new Error(`Invalid thinking level in config.json: ${value}`);
	}
	return value as ThinkingLevel;
}

function resolveTools(value: string | undefined): { tools: string[]; label: string } {
	if (!value || value === "coding") {
		return { tools: [...CODING_TOOL_NAMES], label: "coding" };
	}
	if (value === "readonly") {
		return { tools: [...READONLY_TOOL_NAMES], label: "readonly" };
	}
	if (value === "all") {
		return { tools: [...ALL_BUILTIN_TOOL_NAMES], label: "all" };
	}
	if (value === "none") {
		return { tools: [], label: "none" };
	}

	const names = value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	if (names.length === 0) {
		return { tools: [...CODING_TOOL_NAMES], label: "coding" };
	}

	for (const name of names) {
		if (!VALID_TOOL_NAMES.has(name as BuiltinToolName)) {
			throw new Error(`Invalid tools entry in config.json: ${name}`);
		}
	}

	return {
		tools: names as BuiltinToolName[],
		label: names.join(","),
	};
}

function resolveRunMode(): "start" | "dev" {
	return process.env.PI_FEISHU_RUN_MODE === "dev" ? "dev" : "start";
}

function parseAgentHomeFromArgv(argv: string[]): string | undefined {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--home" && argv[i + 1]) {
			return argv[i + 1];
		}
		if (arg.startsWith("--home=")) {
			return arg.slice("--home=".length);
		}
	}
	return undefined;
}

/**
 * Applies `config.json` → `env` map (e.g. KIMI_API_KEY). Values overwrite shell / `.env` so the
 * store remains authoritative for keys saved by onboard.
 */
function applyConfigStoreEnvToProcess(store: PiFeishuConfigStore): void {
	const extra = store.env;
	if (!extra) {
		return;
	}
	for (const [k, v] of Object.entries(extra)) {
		if (v) {
			process.env[k] = v;
		}
	}
}

export function loadConfig(argv: string[] = process.argv.slice(2)): FeishuBotConfig {
	const homeArg = parseAgentHomeFromArgv(argv);
	loadAgentEnvIntoProcess(homeArg ? { agentHome: homeArg } : undefined);

	const store = loadConfigStore();
	applyConfigStoreEnvToProcess(store);

	const profile = getStoredProfile(store);
	if (!profile) {
		throw new Error(
			"No profile in config.json. Run `pi-feishu onboard` once (see README), or create `<agent-home>/config.json` with channel + model.",
		);
	}

	const ch = profile.channel;
	if (ch.kind !== "feishu") {
		throw new Error(`Unsupported channel kind in config.json: ${(ch as { kind: string }).kind}`);
	}

	const appId = ch.appId?.trim();
	const appSecret = ch.appSecret?.trim();
	if (!appId || !appSecret) {
		throw new Error(
			"config.json: channel.appId and channel.appSecret are required. Re-run `pi-feishu onboard` or edit the file.",
		);
	}

	const m = profile.model;
	if (!m?.provider?.trim() || !m?.model?.trim()) {
		throw new Error(
			"config.json: model.provider and model.model are required. Re-run `pi-feishu onboard` or edit the file.",
		);
	}

	const provider = m.provider.trim();
	const modelId = m.model.trim();
	const homeDir = resolveAgentHomeDir();
	const modelRegistry = ModelRegistry.create(AuthStorage.inMemory(), join(homeDir, "models.json"));
	modelRegistry.refresh();
	const model = modelRegistry.find(provider, modelId);
	if (!model) {
		throw new Error(
			`config.json: model ${provider}/${modelId} was not found. If this is a custom provider, ensure ${homeDir}/models.json defines providers.${provider} with model id "${modelId}".`,
		);
	}
	const modelLabel = `${provider}/${modelId}`;

	const { tools, label: toolLabel } = resolveTools(m.tools ?? "coding");
	const thinkingLevel = parseThinkingLevel(m.thinkingLevel as string | undefined);
	const debug = m.debug ?? false;
	const resumeSessions = m.resumeSessions !== false;
	const outputToolCallsToIm = m.outputToolCallsToIm !== false;

	const runMode = resolveRunMode();

	return {
		homeDir,
		feishu: {
			appId,
			appSecret,
			brand: ch.brand ?? "feishu",
			encryptKey: ch.encryptKey,
			verificationToken: ch.verificationToken,
		},
		model,
		modelLabel,
		thinkingLevel,
		tools,
		toolLabel,
		runMode,
		debug,
		verboseLogs: debug,
		resumeSessions,
		outputToolCallsToIm,
		startedAtMs: Date.now(),
	};
}
