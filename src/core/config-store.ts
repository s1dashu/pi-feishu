import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { resolveAgentHomeDir } from "./agent-home.js";

export type { LoadAgentEnvOptions } from "./agent-home.js";
export { getAgentEnvFilePath, getDefaultAgentHomeDir, loadAgentEnvIntoProcess, resolveAgentHomeDir, upsertAgentEnv } from "./agent-home.js";

export type ChannelKind = "feishu";

export interface FeishuChannelProfile {
	kind: "feishu";
	appId: string;
	appSecret?: string;
	brand?: "feishu" | "lark";
	encryptKey?: string;
	verificationToken?: string;
}

export interface ModelProfile {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string;
	debug?: boolean;
	resumeSessions?: boolean;
	outputToolCallsToIm?: boolean;
	agentDir?: string;
	workDir?: string;
}

/** Stored Feishu + model defaults in `config.json` (includes `channel.appSecret`; optional `store.env` for provider API keys). */
export interface PiFeishuProfile {
	channel: FeishuChannelProfile;
	model: ModelProfile;
}

export interface OwnerSessionBinding {
	chatId: string;
	sessionKey: string;
	openId?: string;
	updatedAt?: string;
}

export interface PiFeishuConfigStore {
	version: 2;
	profile?: PiFeishuProfile;
	ownerSession?: OwnerSessionBinding;
	/** Extra env vars persisted in `config.json` (e.g. `KIMI_API_KEY`). Do not commit. */
	env?: Record<string, string>;
}

const DEFAULT_STORE: PiFeishuConfigStore = {
	version: 2,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizeEnv(raw: unknown): Record<string, string> | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (typeof v === "string" && v.length) {
			out[k] = v;
		}
	}
	return Object.keys(out).length ? out : undefined;
}

function normalizeOwnerSessionBinding(value: unknown): OwnerSessionBinding | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const chatId = typeof value.chatId === "string" ? value.chatId.trim() : "";
	const sessionKeySource = typeof value.sessionKey === "string" ? value.sessionKey.trim() : "";
	if (!chatId) {
		return undefined;
	}
	return {
		chatId,
		sessionKey: sessionKeySource || chatId,
		openId: typeof value.openId === "string" ? value.openId.trim() || undefined : undefined,
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt.trim() || undefined : undefined,
	};
}

export function getConfigStorePath(): string {
	return join(resolveAgentHomeDir(), "config.json");
}

export function loadConfigStore(): PiFeishuConfigStore {
	const path = getConfigStorePath();
	if (!existsSync(path)) {
		return DEFAULT_STORE;
	}

	const raw = readFileSync(path, "utf8").trim();
	if (!raw) {
		return DEFAULT_STORE;
	}

	const parsed = JSON.parse(raw) as Partial<PiFeishuConfigStore> & Record<string, unknown>;
	const directProfile = parsed.profile;
	const directOwnerSession = normalizeOwnerSessionBinding(parsed.ownerSession);
	const fileEnv = normalizeEnv(parsed.env);

	if (directProfile?.channel && directProfile?.model) {
		return {
			version: 2,
			profile: directProfile as PiFeishuProfile,
			ownerSession: directOwnerSession,
			env: fileEnv,
		};
	}

	return {
		version: 2,
		profile: undefined,
		ownerSession: directOwnerSession,
		env: fileEnv,
	};
}

export function saveConfigStore(store: PiFeishuConfigStore): void {
	const path = getConfigStorePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
	try {
		chmodSync(path, 0o600);
	} catch {
		// Best-effort; unsupported on some filesystems.
	}
}

export function hasStoredProfile(store: PiFeishuConfigStore): boolean {
	return Boolean(store.profile);
}

export function getStoredProfile(store: PiFeishuConfigStore): PiFeishuProfile | undefined {
	return store.profile;
}

export function setStoredProfile(store: PiFeishuConfigStore, profile: PiFeishuProfile): PiFeishuConfigStore {
	return {
		version: 2,
		profile,
		ownerSession: store.ownerSession,
		env: store.env,
	};
}

export function mergeConfigStoreEnv(
	store: PiFeishuConfigStore,
	updates: Record<string, string | undefined>,
): PiFeishuConfigStore {
	const base: Record<string, string> = { ...store.env };
	for (const [key, value] of Object.entries(updates)) {
		if (value == null || value === "") {
			delete base[key];
		} else {
			base[key] = value;
		}
	}
	const env = Object.keys(base).length > 0 ? base : undefined;
	return { ...store, env };
}

export function getOwnerSessionBinding(store: PiFeishuConfigStore): OwnerSessionBinding | undefined {
	return store.ownerSession;
}

export function setOwnerSessionBinding(store: PiFeishuConfigStore, ownerSession: OwnerSessionBinding): PiFeishuConfigStore {
	return {
		version: 2,
		profile: store.profile,
		ownerSession,
		env: store.env,
	};
}
