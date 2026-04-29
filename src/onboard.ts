#!/usr/bin/env node

/**
 * Interactive onboarding only (no multi-command CLI).
 * Writes `<agent-home>/config.json` (profile, secrets, optional provider keys in `env`).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { isCancel } from "@clack/prompts";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import {
	expandUserHomePath,
	loadAgentEnvIntoProcess,
	resolveAgentHomeDir,
	shellExportPiFeishuHome,
	shortenHomeInPath,
} from "./core/agent-home.js";
import {
	getStoredProfile,
	loadConfigStore,
	mergeConfigStoreEnv,
	saveConfigStore,
	setStoredProfile,
	type ModelProfile,
	type PiFeishuProfile,
} from "./core/config-store.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function getNpmPackageName(): string {
	try {
		const raw = readFileSync(join(REPO_ROOT, "package.json"), "utf8");
		const pkg = JSON.parse(raw) as { name?: string };
		return pkg.name ?? "pi-feishu";
	} catch {
		return "pi-feishu";
	}
}

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Common provider → API key env name (for optional prompt). */
const PROVIDER_CREDENTIAL_ENV: Record<string, string> = {
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	google: "GEMINI_API_KEY",
	"google-vertex": "GOOGLE_CLOUD_API_KEY",
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	xai: "XAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
	zai: "ZAI_API_KEY",
	mistral: "MISTRAL_API_KEY",
	minimax: "MINIMAX_API_KEY",
	"minimax-cn": "MINIMAX_CN_API_KEY",
	huggingface: "HF_TOKEN",
	opencode: "OPENCODE_API_KEY",
	"opencode-go": "OPENCODE_API_KEY",
	"kimi-coding": "KIMI_API_KEY",
	"azure-openai-responses": "AZURE_OPENAI_API_KEY",
	"github-copilot": "COPILOT_GITHUB_TOKEN",
	"amazon-bedrock": "AWS_BEARER_TOKEN_BEDROCK",
	/** OpenAI-compatible proxy defined in `<agent-home>/models.json` by onboard. */
	"pi-feishu-openai-proxy": "PI_FEISHU_OPENAI_PROXY_API_KEY",
	/** Codex Responses proxy defined in `<agent-home>/models.json` by onboard. */
	"pi-feishu-codex-proxy": "PI_FEISHU_CODEX_PROXY_API_KEY",
};

/** Provider id written to `models.json` for OpenAI-compatible HTTP proxies. */
const PROXY_OPENAI_PROVIDER_ID = "pi-feishu-openai-proxy";
const PROXY_OPENAI_ENV_KEY = "PI_FEISHU_OPENAI_PROXY_API_KEY";
const PROXY_CODEX_PROVIDER_ID = "pi-feishu-codex-proxy";
const PROXY_CODEX_ENV_KEY = "PI_FEISHU_CODEX_PROXY_API_KEY";

export function normalizeOpenAiCompatibleBaseUrl(raw: string): string {
	return raw.trim().replace(/\/+$/, "");
}

export function normalizeOpenAiResponsesBaseUrl(raw: string): string {
	return raw.trim().replace(/\/+$/, "");
}

type ModelsJsonRoot = {
	providers?: Record<string, unknown>;
};

function mergeOpenAiProxyIntoModelsJson(
	homeDir: string,
	baseUrl: string,
	modelId: string,
): void {
	mergeProxyIntoModelsJson(homeDir, PROXY_OPENAI_PROVIDER_ID, {
		baseUrl,
		api: "openai-completions",
		apiKey: PROXY_OPENAI_ENV_KEY,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		},
		models: [{ id: modelId }],
	});
}

function mergeCodexProxyIntoModelsJson(
	homeDir: string,
	baseUrl: string,
	modelId: string,
): void {
	mergeProxyIntoModelsJson(homeDir, PROXY_CODEX_PROVIDER_ID, {
		baseUrl,
		api: "openai-responses",
		apiKey: PROXY_CODEX_ENV_KEY,
		models: [
			{
				id: modelId,
				reasoning: true,
				contextWindow: 272000,
				maxTokens: 128000,
			},
		],
	});
}

function mergeProxyIntoModelsJson(homeDir: string, providerId: string, providerConfig: unknown): void {
	const path = join(homeDir, "models.json");
	let root: ModelsJsonRoot = {};
	if (existsSync(path)) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				root = parsed as ModelsJsonRoot;
			}
		} catch {
			p.log.warn(`Could not parse existing models.json; overwriting structure at ${path}`);
		}
	}
	if (!root.providers || typeof root.providers !== "object") {
		root.providers = {};
	}
	root.providers[providerId] = providerConfig;
	writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, "utf8");
}

async function pickOpenAiCompatibleProxy(homeDir: string): Promise<{
	provider: string;
	modelId: string;
	preloadedEnv: Record<string, string>;
}> {
	const baseRaw = stringOrCancel(
		await p.text({
			message: "OpenAI-compatible API base URL",
			placeholder: "https://your-gateway.example.com",
		}),
	).trim();
	if (!baseRaw) {
		throw new Error("API base URL is required");
	}
	const baseUrl = normalizeOpenAiCompatibleBaseUrl(baseRaw);
	if (!baseUrl) {
		throw new Error("API base URL is required");
	}

	const modelId = stringOrCancel(
		await p.text({
			message: "Model id (as your API expects, e.g. gpt-4o or a deployment name)",
			placeholder: "gpt-4o-mini",
		}),
	).trim();
	if (!modelId) {
		throw new Error("Model id is required");
	}

	const keyRaw = stringOrCancel(
		await p.password({
			message: `${PROXY_OPENAI_ENV_KEY} (stored in config.json → env; referenced from models.json)`,
			mask: "*",
		}),
	).trim();
	if (!keyRaw) {
		p.log.warn(
			`No API key saved; set ${PROXY_OPENAI_ENV_KEY} in shell or re-run onboard. Model calls will fail until then.`,
		);
	}

	mergeOpenAiProxyIntoModelsJson(homeDir, baseUrl, modelId);

	return {
		provider: PROXY_OPENAI_PROVIDER_ID,
		modelId,
		preloadedEnv: keyRaw ? { [PROXY_OPENAI_ENV_KEY]: keyRaw } : {},
	};
}

async function pickCodexProxy(homeDir: string): Promise<{
	provider: string;
	modelId: string;
	preloadedEnv: Record<string, string>;
}> {
	const baseRaw = stringOrCancel(
		await p.text({
			message: "OpenAI Responses-compatible base URL",
			placeholder: "https://your-gateway.example.com/v1",
		}),
	).trim();
	const baseUrl = normalizeOpenAiResponsesBaseUrl(baseRaw);
	if (!baseUrl) {
		throw new Error("API base URL is required");
	}

	const modelId = stringOrCancel(
		await p.text({
			message: "Responses model id (as your API expects)",
			placeholder: "gpt-5.5",
			defaultValue: "gpt-5.5",
		}),
	).trim();
	if (!modelId) {
		throw new Error("Model id is required");
	}

	const keyRaw = stringOrCancel(
		await p.password({
			message: `${PROXY_CODEX_ENV_KEY} (stored in config.json → env; referenced from models.json)`,
			mask: "*",
		}),
	).trim();
	if (!keyRaw) {
		p.log.warn(
			`No API key saved; set ${PROXY_CODEX_ENV_KEY} in shell or re-run onboard. Model calls will fail until then.`,
		);
	}

	mergeCodexProxyIntoModelsJson(homeDir, baseUrl, modelId);

	return {
		provider: PROXY_CODEX_PROVIDER_ID,
		modelId,
		preloadedEnv: keyRaw ? { [PROXY_CODEX_ENV_KEY]: keyRaw } : {},
	};
}

function assertValue<T>(value: T | symbol, cancelMessage = "Cancelled"): T {
	if (isCancel(value)) {
		p.cancel(cancelMessage);
		process.exit(0);
	}
	return value;
}

/** `text` / `password` may yield `undefined` on empty submit (not cancel); normalize to string. */
function stringOrCancel(value: string | symbol | undefined, cancelMessage = "Cancelled"): string {
	if (isCancel(value)) {
		p.cancel(cancelMessage);
		process.exit(0);
	}
	return value ?? "";
}

async function confirmOrExit(message: string, initialValue: boolean): Promise<boolean> {
	const v = await p.confirm({ message, initialValue });
	if (isCancel(v)) {
		p.cancel("Cancelled");
		process.exit(0);
	}
	return v;
}

function parseHomeArg(argv: string[]): string | undefined {
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

const CLI_DIST = join(REPO_ROOT, "dist/cli.js");
const CLI_SRC = join(REPO_ROOT, "src/cli.ts");
const TSX_CLI = join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");

function getBotLaunchCommand(): { execPath: string; argv: string[] } {
	/** Match `npm run start`: prefer tsx + `src` when present so stale `dist` does not run after onboard. */
	if (existsSync(TSX_CLI) && existsSync(CLI_SRC)) {
		return { execPath: process.execPath, argv: [TSX_CLI, CLI_SRC] };
	}
	if (existsSync(CLI_DIST)) {
		return { execPath: process.execPath, argv: [CLI_DIST] };
	}
	throw new Error(
		"CLI entry not found: run `npm run build` for published installs, or `npm install` in this repo and retry.",
	);
}

/**
 * Pi `ModelRegistry` + Clack select/autocomplete, or manual entry.
 */
async function pickProviderAndModel(
	homeDir: string,
	exModel: ModelProfile | undefined,
): Promise<{ provider: string; modelId: string; preloadedEnv: Record<string, string> }> {
	const mode = assertValue(
		await p.select<"list" | "manual" | "proxy">({
			message: "Model setup",
			options: [
				{ value: "list", label: "Choose from Pi model catalog", hint: "Recommended" },
				{ value: "manual", label: "Type provider and model id manually" },
				{ value: "proxy", label: "Custom API endpoint (proxy)", hint: "OpenAI/Codex-compatible" },
			],
			initialValue: "list",
		}),
	);

	if (mode === "proxy") {
		const apiStyle = assertValue(
			await p.select<"openai" | "codex">({
				message: "Which API does this endpoint speak?",
				options: [
					{
						value: "openai",
						label: "OpenAI-compatible (Chat Completions)",
						hint: "/v1/chat/completions",
					},
					{
						value: "codex",
						label: "OpenAI Responses-compatible",
						hint: "/v1/responses, Codex-style models",
					},
				],
				initialValue: "openai",
			}),
		);
		if (apiStyle === "codex") {
			return await pickCodexProxy(homeDir);
		}
		return await pickOpenAiCompatibleProxy(homeDir);
	}

	if (mode === "manual") {
		const defProv = exModel?.provider ?? "kimi-coding";
		const provider =
			stringOrCancel(
				await p.text({
					message: "Model provider",
					placeholder: defProv,
					defaultValue: defProv,
				}),
			).trim() || defProv;

		const defModel = exModel?.model ?? "k2p5";
		const modelId =
			stringOrCancel(
				await p.text({
					message: "Model id",
					placeholder: defModel,
					defaultValue: defModel,
				}),
			).trim() || defModel;

		return { provider, modelId, preloadedEnv: {} };
	}

	const spin = p.spinner();
	spin.start("Loading Pi model catalog…");
	const registry = ModelRegistry.create(AuthStorage.inMemory(), join(homeDir, "models.json"));
	registry.refresh();
	const all: Model<any>[] = registry.getAll();
	spin.stop(all.length ? `Loaded ${all.length} models` : "Model catalog is empty");

	if (!all.length) {
		throw new Error("Model catalog is empty. Choose manual entry instead.");
	}

	const providers = [...new Set(all.map((m) => String(m.provider)))].sort((a, b) => a.localeCompare(b));
	const provInitial =
		exModel?.provider && providers.includes(exModel.provider) ? exModel.provider : providers[0]!;

	const provider = assertValue(
		await p.select({
			message: "Provider (Pi catalog)",
			options: providers.map((pr) => ({ value: pr, label: pr })),
			initialValue: provInitial,
			maxItems: 16,
		}),
	);

	const modelsForProv = all.filter((m) => String(m.provider) === provider);
	if (!modelsForProv.length) {
		p.log.warn(`No models listed for provider "${provider}". Enter a model id.`);
		const modelId = stringOrCancel(
			await p.text({
				message: "Model id",
				placeholder: exModel?.model ?? "",
				...(exModel?.model ? { defaultValue: exModel.model } : {}),
			}),
		).trim();
		if (!modelId) {
			throw new Error("Model id is required");
		}
		return { provider, modelId, preloadedEnv: {} };
	}

	const modelItems = modelsForProv.map((m) => ({
		value: m.id,
		label: m.name && m.name !== m.id ? `${m.id} — ${m.name}` : m.id,
	}));
	const modelInitial =
		exModel?.model && modelItems.some((x) => x.value === exModel.model)
			? exModel.model
			: modelItems[0]!.value;

	const modelId = assertValue(
		await p.autocomplete({
			message: `Model · ${provider} (type to filter)`,
			options: modelItems,
			initialValue: modelInitial,
			placeholder: "Type to filter…",
			maxItems: 12,
		}),
	);

	return { provider, modelId, preloadedEnv: {} };
}

export async function runOnboard(argv: string[]): Promise<void> {
	const homeArg = parseHomeArg(argv);
	loadAgentEnvIntoProcess(homeArg ? { agentHome: homeArg } : {});

	p.intro("pi-feishu — setup wizard");

	const homeDefaultAbs = resolveAgentHomeDir();
	const homeDefaultShown = shortenHomeInPath(homeDefaultAbs);
	const homeRaw = stringOrCancel(
		await p.text({
			message: "Agent home directory (~/.pi-feishu or absolute path)",
			placeholder: homeDefaultShown,
			defaultValue: homeDefaultShown,
		}),
	).trim();
	const homeDir = expandUserHomePath(homeRaw || homeDefaultShown);
	mkdirSync(homeDir, { recursive: true });
	process.env.PI_FEISHU_HOME = homeDir;
	loadAgentEnvIntoProcess({ agentHome: homeDir });

	const store = loadConfigStore();
	const ex = getStoredProfile(store);
	const exCh = ex?.channel.kind === "feishu" ? ex.channel : undefined;
	const exModel = ex?.model;

	const appId = stringOrCancel(
		await p.text({
			message: "Feishu App ID",
			placeholder: exCh?.appId ?? "Required",
			...(exCh?.appId ? { defaultValue: exCh.appId } : {}),
		}),
	).trim();
	if (!appId) {
		throw new Error("Feishu App ID is required");
	}

	const existingSecret = exCh?.appSecret?.trim() ?? "";
	const appSecret = stringOrCancel(
		await p.text({
			message: existingSecret
				? "Feishu App Secret — press Enter to keep the value below, or type to replace"
				: "Feishu App Secret",
			placeholder: existingSecret || "Required",
			...(existingSecret ? { defaultValue: existingSecret } : {}),
			validate: (v) => {
				if (!existingSecret && !(v ?? "").trim()) {
					return "Feishu App Secret is required";
				}
				return undefined;
			},
		}),
	).trim() || existingSecret;
	if (!appSecret) {
		throw new Error("Feishu App Secret is required");
	}

	const encryptKey = stringOrCancel(
		await p.text({
			message: "Feishu Encrypt Key (optional)",
			placeholder: "Leave empty to skip",
			...(exCh?.encryptKey ? { defaultValue: exCh.encryptKey } : {}),
		}),
	).trim() || undefined;

	const verificationToken = stringOrCancel(
		await p.text({
			message: "Feishu Verification Token (optional)",
			placeholder: "Leave empty to skip",
			...(exCh?.verificationToken ? { defaultValue: exCh.verificationToken } : {}),
		}),
	).trim() || undefined;

	const brand = assertValue(
		await p.select<"feishu" | "lark">({
			message: "App region",
			options: [
				{ value: "feishu", label: "Feishu (China)" },
				{ value: "lark", label: "Lark (international)" },
			],
			initialValue: exCh?.brand === "lark" ? "lark" : "feishu",
		}),
	);

	const { provider, modelId, preloadedEnv: modelPreloadedEnv } = await pickProviderAndModel(homeDir, exModel);

	const defThink = exModel?.thinkingLevel ?? "off";
	const thinkingLevel = assertValue(
		await p.select<ThinkingLevel>({
			message: "Thinking level",
			options: THINKING_LEVELS.map((lvl) => ({ value: lvl, label: lvl })),
			initialValue: THINKING_LEVELS.includes(defThink) ? defThink : "off",
		}),
	);

	const defTools = exModel?.tools ?? "coding";
	const tools =
		stringOrCancel(
			await p.text({
				message: "Tool preset",
				placeholder: "coding | readonly | all | none | comma-separated",
				defaultValue: defTools,
			}),
		).trim() || defTools;

	const resumeSessions = await confirmOrExit(
		"Persist sessions across restarts?",
		exModel?.resumeSessions !== false,
	);

	const outputToolCallsToIm = await confirmOrExit(
		"Show tool calls in chat?",
		exModel?.outputToolCallsToIm !== false,
	);

	const credEnv = PROVIDER_CREDENTIAL_ENV[provider];
	const existingProviderKey =
		(credEnv ? process.env[credEnv]?.trim() || store.env?.[credEnv]?.trim() : undefined) || "";
	const extraEnv: Record<string, string> = { ...modelPreloadedEnv };
	if (credEnv && modelPreloadedEnv[credEnv]) {
		p.log.info(`Using API key from proxy setup (${credEnv}).`);
	}
	if (credEnv) {
		if (extraEnv[credEnv]) {
			// Key already supplied (e.g. OpenAI-compatible proxy path).
		} else if (existingProviderKey) {
			p.log.info(
				`${credEnv} is already set (shell or saved config). You can skip replacing unless you want a new key in config.`,
			);
			const replace = await p.confirm({
				message: `Replace ${credEnv} in config with a new value?`,
				initialValue: false,
			});
			if (isCancel(replace)) {
				p.cancel("Cancelled");
				process.exit(0);
			}
			if (replace) {
				const keyRaw = stringOrCancel(
					await p.password({
						message: `${credEnv} (new value → stored in config)`,
						mask: "*",
					}),
				);
				if (keyRaw.trim()) {
					extraEnv[credEnv] = keyRaw.trim();
				}
			}
		} else {
			const keyRaw = stringOrCancel(
				await p.password({
					message: `${credEnv} — required for provider "${provider}" unless already exported in your shell (stored in config)`,
					mask: "*",
				}),
			);
			if (keyRaw.trim()) {
				extraEnv[credEnv] = keyRaw.trim();
			} else if (!process.env[credEnv]?.trim()) {
				p.log.warn(
					`No ${credEnv} saved; model calls will fail until you export it or re-run onboard and paste a key.`,
				);
			}
		}
	} else {
		p.log.warn(
			`No preset API-key env name for provider "${provider}". Set credentials per pi-coding-agent / provider docs (env or manual config).`,
		);
	}

	const profile: PiFeishuProfile = {
		channel: {
			kind: "feishu",
			appId,
			appSecret,
			brand,
			...(encryptKey ? { encryptKey } : {}),
			...(verificationToken ? { verificationToken } : {}),
		},
		model: {
			provider,
			model: modelId,
			thinkingLevel,
			tools,
			debug: exModel?.debug ?? false,
			resumeSessions,
			outputToolCallsToIm,
		},
	};

	let nextStore = setStoredProfile(store, profile);
	if (Object.keys(extraEnv).length > 0) {
		nextStore = mergeConfigStoreEnv(nextStore, extraEnv);
	}
	saveConfigStore(nextStore);

	p.log.success(`Saved\n  ${shortenHomeInPath(resolve(homeDir, "config.json"))}`);

	if (await confirmOrExit("Start the bot now?", true)) {
		const { execPath, argv } = getBotLaunchCommand();
		const child = spawn(execPath, argv, {
			cwd: REPO_ROOT,
			stdio: "inherit",
			env: { ...process.env, PI_FEISHU_HOME: homeDir },
		});
		await new Promise<void>((resolvePromise, reject) => {
			child.on("exit", (code, signal) => {
				if (signal) {
					reject(new Error(`child signal ${signal}`));
					return;
				}
				if (code !== 0 && code != null) {
					reject(new Error(`exit ${code}`));
					return;
				}
				resolvePromise();
			});
			child.on("error", reject);
		});
		p.outro("Bot exited");
	} else {
		p.note(
			`${shellExportPiFeishuHome(homeDir)} && pi-feishu (or npx ${getNpmPackageName()})`,
			"Tip",
		);
		p.outro("Setup complete");
	}
}
