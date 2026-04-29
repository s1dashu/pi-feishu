import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import chalk from "chalk";
import { sanitizePathSegment } from "./messages.js";

/** Nested path layout expected by pi-coding-agent `SessionManager` for session JSONL files. */
function getPiSessionHistoryDir(conversationDir: string, agentHome: string): string {
	const safePath = `--${agentHome.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(conversationDir, "sessions", safePath);
}

function getLatestSessionFile(sessionDir: string): string | undefined {
	if (!existsSync(sessionDir)) {
		return undefined;
	}

	const files = readdirSync(sessionDir)
		.filter((name) => name.endsWith(".jsonl"))
		.sort((left, right) => left.localeCompare(right));
	const latest = files.at(-1);
	return latest ? join(sessionDir, latest) : undefined;
}

export interface SessionPoolOptions {
	homeDir: string;
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: string[];
	debug: boolean;
	verboseLogs: boolean;
	resumeSessions: boolean;
}

function formatUserText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.flatMap((part) => {
			if (!part || typeof part !== "object") {
				return [];
			}
			const typedPart = part as { type?: unknown; text?: unknown };
			return typedPart.type === "text" && typeof typedPart.text === "string" ? [typedPart.text] : [];
		})
		.join("");
}

function truncate(text: string, max = 160): string {
	return text.length > max ? `${text.slice(0, max)}...` : text;
}

const TOOL_DEBUG_MAX_CHARS = 500;

function formatDebugValue(value: unknown): string {
	if (typeof value === "string") {
		return truncate(value, TOOL_DEBUG_MAX_CHARS);
	}
	try {
		return truncate(JSON.stringify(value ?? {}), TOOL_DEBUG_MAX_CHARS);
	} catch {
		return truncate(String(value), TOOL_DEBUG_MAX_CHARS);
	}
}

function attachSessionLogging(session: AgentSession): void {
	let activeStream: "assistant" | "thinking" | null = null;
	let sawAssistantTextDelta = false;

	function formatDuration(ms: number): string {
		if (ms < 1000) {
			return `${ms}ms`;
		}
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function flushStream(): void {
		if (activeStream) {
			process.stdout.write("\n");
			activeStream = null;
		}
	}

	session.subscribe((event) => {
		switch (event.type) {
			case "compaction_start":
				flushStream();
				console.log(chalk.yellow(`> context_compaction start reason=${event.reason}`));
				break;
			case "compaction_end":
				flushStream();
				console.log(
					chalk.yellow(
						`> context_compaction end reason=${event.reason} aborted=${event.aborted ? "yes" : "no"} retry=${event.willRetry ? "yes" : "no"}${event.errorMessage ? ` error=${truncate(event.errorMessage)}` : ""}`,
					),
				);
				break;
			case "auto_retry_start":
				flushStream();
				console.log(
					chalk.yellow(
						`> provider_retry start attempt=${event.attempt}/${event.maxAttempts} delay=${formatDuration(event.delayMs)} error=${truncate(event.errorMessage)}`,
					),
				);
				break;
			case "auto_retry_end":
				flushStream();
				console.log(
					chalk.yellow(
						`> provider_retry end success=${event.success ? "yes" : "no"} attempt=${event.attempt}${event.finalError ? ` error=${truncate(event.finalError)}` : ""}`,
					),
				);
				break;
			case "message_start": {
				const message = event.message as { role?: string; content?: unknown };
				if (message.role === "user") {
					flushStream();
					const text = formatUserText(message.content);
					console.log(`${chalk.cyan("User:")} ${truncate(text)}`);
				} else if (message.role === "assistant") {
					sawAssistantTextDelta = false;
				}
				break;
			}
			case "message_update": {
				const assistantEvent = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
				if (assistantEvent?.type === "thinking_delta" && assistantEvent.delta) {
					if (activeStream !== "thinking") {
						flushStream();
						process.stdout.write(chalk.gray("> Thinking "));
						activeStream = "thinking";
					}
					process.stdout.write(chalk.gray(assistantEvent.delta));
				}
				if (assistantEvent?.type === "text_delta" && assistantEvent.delta) {
					sawAssistantTextDelta = true;
					if (activeStream !== "assistant") {
						flushStream();
						process.stdout.write(`${chalk.green("Agent:")} `);
						activeStream = "assistant";
					}
					process.stdout.write(chalk.green(assistantEvent.delta));
				}
				break;
			}
			case "message_end": {
				const message = event.message as { role?: string; content?: unknown };
				if (message.role === "assistant") {
					flushStream();
					const finalText = extractAssistantText(session);
					if (finalText && !sawAssistantTextDelta) {
						console.log(`${chalk.green("Agent:")} ${truncate(finalText)}`);
					}
				}
				break;
			}
			case "tool_execution_start":
				flushStream();
				console.log(chalk.gray(`Tool Call: ${event.toolName} ${formatDebugValue(event.args)}`));
				break;
			case "tool_execution_end":
				flushStream();
				console.log(
					event.isError
						? chalk.red(`Tool Response: ${event.toolName} ${formatDebugValue(event.result)}`)
						: chalk.blue(`Tool Response: ${event.toolName} ${formatDebugValue(event.result)}`),
				);
				break;
		}
	});
}

function logSessionInitTiming(
	conversationKey: string,
	steps: Array<{ label: string; durationMs: number }>,
	totalMs: number,
): void {
	const formattedSteps = steps.map((step) => `${step.label}=${step.durationMs}ms`).join(" ");
	console.log(chalk.gray(`> session_init ${conversationKey} total=${totalMs}ms ${formattedSteps}`));
}

export class SessionPool {
	private readonly options: SessionPoolOptions;
	private readonly authStorage: AuthStorage;
	private readonly modelRegistry: ModelRegistry;
	private readonly sessions = new Map<string, AgentSession>();

	constructor(options: SessionPoolOptions) {
		this.options = options;
		this.authStorage = AuthStorage.inMemory();
		this.modelRegistry = ModelRegistry.create(this.authStorage, join(options.homeDir, "models.json"));
	}

	async getSession(conversationKey: string): Promise<AgentSession> {
		const existing = this.sessions.get(conversationKey);
		if (existing) {
			if (this.options.verboseLogs) {
				console.log(chalk.gray(`> session_reuse ${conversationKey}`));
			}
			return existing;
		}

		const initStartedAt = Date.now();
		const initSteps: Array<{ label: string; durationMs: number }> = [];
		const conversationDir = join(this.options.homeDir, "sessions", sanitizePathSegment(conversationKey));
		mkdirSync(conversationDir, { recursive: true });
		const sessionHistoryDir = getPiSessionHistoryDir(conversationDir, this.options.homeDir);
		mkdirSync(sessionHistoryDir, { recursive: true });
		const configuredModel = this.options.model;
		const resourceLoader = new DefaultResourceLoader({
			cwd: this.options.homeDir,
			agentDir: conversationDir,
			/** Default Pi system prompt + Feishu/Lark IM constraints (no separate prompt file in this package). */
			systemPromptOverride: (base) => {
				const feishuIm =
					"## Feishu / Lark IM\nNever output Markdown tables; the client does not render them reliably. Use plain paragraphs, numbered lists, or bullet lists instead.";
				const backend =
					configuredModel != null
						? `## Session backend (pi-feishu)\nRequests use provider \`${String(configuredModel.provider)}\` and model id \`${configuredModel.id}\` (OpenAI-compatible transport only describes the HTTP API; the underlying engine may differ). In Feishu, present yourself as the user's coding assistant; do not insist you are a particular vendor-branded chatbot unless the user asks or the model id clearly names that vendor.`
						: "## Session backend (pi-feishu)\nYou are the user's coding assistant in Feishu.";
				const head = base?.trim() ?? "";
				const tail = `${feishuIm}\n\n${backend}`;
				return head ? `${head}\n\n${tail}` : tail;
			},
		});
		const reloadStartedAt = Date.now();
		await resourceLoader.reload();
		initSteps.push({ label: "reload", durationMs: Date.now() - reloadStartedAt });
		const latestSessionFile = this.options.resumeSessions ? getLatestSessionFile(sessionHistoryDir) : undefined;
		const sessionManagerStartedAt = Date.now();
		const sessionManager = this.options.resumeSessions
			? latestSessionFile
				? SessionManager.open(latestSessionFile, sessionHistoryDir)
				: SessionManager.create(this.options.homeDir, sessionHistoryDir)
			: SessionManager.inMemory();
		initSteps.push({
			label: latestSessionFile ? "session_open" : this.options.resumeSessions ? "session_create" : "session_memory",
			durationMs: Date.now() - sessionManagerStartedAt,
		});

		const createStartedAt = Date.now();
		const { session, modelFallbackMessage } = await createAgentSession({
			authStorage: this.authStorage,
			cwd: this.options.homeDir,
			agentDir: conversationDir,
			model: this.options.model,
			modelRegistry: this.modelRegistry,
			thinkingLevel: this.options.thinkingLevel,
			tools: this.options.tools,
			customTools: [],
			resourceLoader,
			sessionManager,
		});
		initSteps.push({ label: "create_agent_session", durationMs: Date.now() - createStartedAt });

		if (modelFallbackMessage) {
			console.warn(chalk.yellow(`Model fallback: ${modelFallbackMessage}`));
		}
		if (this.options.verboseLogs) {
			logSessionInitTiming(conversationKey, initSteps, Date.now() - initStartedAt);
		}
		if (this.options.debug) {
			console.log(
				chalk.gray(
					`Session: ${this.options.resumeSessions ? "persistent" : "ephemeral"}, history ${session.state.messages.length}`,
				),
			);
		}
		attachSessionLogging(session);

		this.sessions.set(conversationKey, session);
		return session;
	}
}

export function extractAssistantText(session: AgentSession): string {
	const messages = [...session.state.messages].reverse();
	for (const message of messages) {
		if ((message as { role?: string }).role !== "assistant") {
			continue;
		}

		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") {
			return content.trim();
		}
		if (!Array.isArray(content)) {
			return "";
		}

		return content
			.flatMap((part) => {
				if (!part || typeof part !== "object") {
					return [];
				}
				const typedPart = part as { type?: unknown; text?: unknown };
				return typedPart.type === "text" && typeof typedPart.text === "string" ? [typedPart.text] : [];
			})
			.join("")
			.trim();
	}

	return "";
}

export function extractLastAssistantError(session: AgentSession): string | undefined {
	const messages = [...session.state.messages].reverse();
	for (const message of messages) {
		const typedMessage = message as { role?: string; stopReason?: string; errorMessage?: unknown };
		if (typedMessage.role !== "assistant") {
			continue;
		}
		if (typedMessage.stopReason !== "error") {
			return undefined;
		}
		return typeof typedMessage.errorMessage === "string" && typedMessage.errorMessage.trim()
			? typedMessage.errorMessage.trim()
			: "Model provider returned an error without details.";
	}
	return undefined;
}
