#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { type LarkMessageEvent, LarkClient, sendTextLark } from "./platform/index.js";
import chalk from "chalk";
import { loadConfig } from "./config.js";
import {
	extractPromptText,
	getConversationKey,
	isRecentMessage,
	MessageDedup,
	shouldHandleMessage,
} from "./messages.js";
import { extractAssistantText, SessionPool } from "./session.js";

const config = loadConfig();
const dedup = new MessageDedup();
const abortController = new AbortController();
const sessionPool = new SessionPool({
	homeDir: config.homeDir,
	model: config.model,
	thinkingLevel: config.thinkingLevel,
	tools: config.tools,
	debug: config.debug,
	verboseLogs: config.verboseLogs,
	resumeSessions: config.resumeSessions,
});
const conversations = new Map<string, ConversationController>();
const WORKING_REACTION = "Get";
const MAX_MESSAGE_EDITS = 20;
const STREAM_UPDATE_DEBOUNCE_MS = 400;
const TOOL_CALL_DETAIL_MAX = 2000;
const DEFAULT_TOOL_IM_EMOJI = "🖥️";
let currentBotOpenId: string | undefined;
/** Set in `main` so signal handlers can force-close the Feishu WS without waiting on `startWS` promise edges. */
let larkClientForShutdown: LarkClient | undefined;
/** Non-zero when shutting down via signal; Node won't exit after SIGINT if listeners exist and handles remain open. */
let shutdownExitCode = 0;
let forceExitAfterInterruptTimer: ReturnType<typeof setTimeout> | undefined;
let sigintCount = 0;

function armForceExitAfterInterrupt(code: number): void {
	if (forceExitAfterInterruptTimer != null) {
		return;
	}
	forceExitAfterInterruptTimer = setTimeout(() => {
		forceExitAfterInterruptTimer = undefined;
		console.error("\n[pi-feishu] Graceful shutdown is taking too long; forcing exit.");
		process.exit(code);
	}, 2500);
	/** Keep a ref so this timer still fires while other handles (WS, HTTP) wind down. */
}

function disarmForceExitAfterInterrupt(): void {
	if (forceExitAfterInterruptTimer != null) {
		clearTimeout(forceExitAfterInterruptTimer);
		forceExitAfterInterruptTimer = undefined;
	}
}

type SessionEvent = Parameters<AgentSession["subscribe"]>[0] extends (event: infer TEvent) => void ? TEvent : never;

interface AssistantSegment {
	kind: "assistant" | "thinking";
	content: string;
	messageId?: string;
	messagePrefix: string;
	messageEditCount: number;
	lastRendered: string;
}

/** Merge consecutive tool calls into one IM (edit to append); reset when assistant text starts. */
interface ToolRunImBlock {
	content: string;
	messageId?: string;
	messagePrefix: string;
	messageEditCount: number;
	lastRendered: string;
}

function truncate(text: string, max = 600): string {
	return text.length > max ? `${text.slice(0, max)}...` : text;
}

function printStartupSummary(): void {
	const sessionMode = config.resumeSessions ? "persistent" : "ephemeral";
	const lines = [
		chalk.bold("pi-feishu — Pi Coding Agent in Feishu/Lark"),
		chalk.gray(`  mode       ${config.runMode}`),
		chalk.gray(`  home       ${config.homeDir}`),
		chalk.gray(`  sessions   ${sessionMode} (${join(config.homeDir, "sessions")})`),
		chalk.gray(`  model      ${config.modelLabel}`),
		chalk.gray(`  tools      ${config.toolLabel} (pi-coding-agent)`),
		chalk.gray(`  thinking   ${config.thinkingLevel}`),
		chalk.gray(`  system     default (pi-coding-agent / Pi resource loader)`),
		chalk.gray(`  debug      ${config.debug ? "on" : "off"}`),
		chalk.gray(`  verbose    ${config.verboseLogs ? "on" : "off"}`),
		chalk.gray("  status     waiting for Feishu events..."),
	];
	console.log(lines.join("\n"));
}

function stringifyCompact(value: unknown, max = 1200): string {
	const text = typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 0) || "{}";
	return truncate(text.replace(/\s+/g, " "), max);
}

function toolCallImEmoji(toolLabel: string): string {
	const base = toolLabel.replace(/\s+error$/i, "").trim().toLowerCase();
	switch (base) {
		case "read":
			return "📖";
		case "write":
			return "📝";
		case "edit":
			return "✏️";
		case "bash":
			return DEFAULT_TOOL_IM_EMOJI;
		default:
			return DEFAULT_TOOL_IM_EMOJI;
	}
}

function imBasename(pathStr: string): string {
	const t = pathStr.trim();
	const b = basename(t);
	return b || t || "(unknown)";
}

function formatToolImLine(toolName: string, args: unknown): string {
	const emoji = toolCallImEmoji(toolName);
	const base = toolName.replace(/\s+error$/i, "").trim().toLowerCase();
	const rec =
		args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};

	if (base === "bash") {
		const cmd = typeof rec.command === "string" ? rec.command.trim().replace(/\s+/g, " ") : "";
		const shown = cmd ? truncate(cmd, TOOL_CALL_DETAIL_MAX) : "(no command)";
		return `${emoji} bash ${shown}`;
	}
	if (base === "read" || base === "write" || base === "edit") {
		const pathStr = typeof rec.path === "string" ? rec.path : "";
		return `${emoji} ${base} ${imBasename(pathStr || "(no path)")}`;
	}
	if (base === "grep") {
		const pat = typeof rec.pattern === "string" ? rec.pattern.trim().replace(/\s+/g, " ") : "";
		const pathStr = typeof rec.path === "string" ? rec.path.trim() : "";
		const tail = pathStr ? ` ${imBasename(pathStr)}` : "";
		return `${emoji} grep ${pat ? truncate(pat, 600) : "?"}` + tail;
	}
	if (base === "find") {
		const pathStr = typeof rec.path === "string" ? rec.path.trim() : "";
		const pat = typeof rec.pattern === "string" ? rec.pattern.trim() : "";
		const head = pathStr ? imBasename(pathStr) : ".";
		return `${emoji} find ${pat ? `${head} ${truncate(pat.replace(/\s+/g, " "), 400)}` : head}`;
	}
	if (base === "ls") {
		const pathStr = typeof rec.path === "string" ? rec.path.trim() : "";
		return `${emoji} ls ${pathStr ? imBasename(pathStr) : "."}`;
	}

	const hint = firstStringFieldForIm(rec);
	return hint ? `${emoji} ${base} ${hint}` : `${emoji} ${toolName.replace(/\s+error$/i, "").trim()}`;
}

function firstStringFieldForIm(rec: Record<string, unknown>): string {
	for (const v of Object.values(rec)) {
		if (typeof v === "string" && v.trim()) {
			return truncate(v.trim().replace(/\s+/g, " "), 500);
		}
	}
	return "";
}

function formatToolImErrorSummary(result: unknown): string {
	if (result == null) {
		return "";
	}
	if (typeof result === "string") {
		return truncate(result.trim().replace(/\s+/g, " "), TOOL_CALL_DETAIL_MAX);
	}
	if (typeof result === "object") {
		const r = result as Record<string, unknown>;
		const content = r.content;
		if (Array.isArray(content)) {
			const parts: string[] = [];
			for (const c of content) {
				if (c && typeof c === "object" && (c as { type?: string; text?: string }).type === "text") {
					const t = (c as { text?: string }).text;
					if (typeof t === "string" && t.trim()) {
						parts.push(t.trim());
					}
				}
			}
			if (parts.length) {
				return truncate(parts.join(" ").replace(/\s+/g, " "), TOOL_CALL_DETAIL_MAX);
			}
		}
		if (typeof r.message === "string" && r.message.trim()) {
			return truncate(r.message.trim().replace(/\s+/g, " "), TOOL_CALL_DETAIL_MAX);
		}
	}
	return truncate(String(result).replace(/\s+/g, " "), TOOL_CALL_DETAIL_MAX);
}

function formatToolImErrorLine(toolName: string, result: unknown): string {
	const emoji = toolCallImEmoji(`${toolName} error`);
	const msg = formatToolImErrorSummary(result);
	return msg ? `${emoji} ${toolName} error ${msg}` : `${emoji} ${toolName} error`;
}

function toQuotedMarkdown(label: string, body: string): string {
	const lines = body.trim() ? body.split("\n").map((line) => `> ${line}`) : [];
	return [`> ${label}`, ...lines].join("\n");
}

function getContinuationText(fullText: string, shownPrefix: string): string {
	if (!shownPrefix) {
		return fullText;
	}
	return fullText.startsWith(shownPrefix) ? fullText.slice(shownPrefix.length) : fullText;
}

function extractLarkErrorInfo(error: unknown): { status?: number; code?: number; msg?: string; message: string } {
	if (error instanceof Error) {
		const response = (
			error as Error & {
				response?: { status?: number; data?: { code?: number; msg?: string } };
			}
		).response;
		const status = response?.status;
		const code = response?.data?.code;
		const msg = response?.data?.msg;
		return {
			status,
			code,
			msg,
			message: msg ?? error.message,
		};
	}

	if (typeof error === "object" && error !== null) {
		const typedError = error as {
			response?: { status?: number; data?: { code?: number; msg?: string } };
			message?: unknown;
		};
		const status = typedError.response?.status;
		const code = typedError.response?.data?.code;
		const msg = typedError.response?.data?.msg;
		return {
			status,
			code,
			msg,
			message: msg ?? (typeof typedError.message === "string" ? typedError.message : String(error)),
		};
	}

	return { message: String(error) };
}

function formatLarkError(error: unknown): string {
	const info = extractLarkErrorInfo(error);
	const parts = [info.message];
	if (info.code !== undefined) {
		parts.push(`code=${info.code}`);
	}
	if (info.status !== undefined) {
		parts.push(`status=${info.status}`);
	}
	return parts.join(" | ");
}

function isMessageEditLimitError(error: unknown): boolean {
	const info = extractLarkErrorInfo(error);
	return info.code === 230072 || info.message.includes("reached the number of times it can be edited");
}

function isAbortLikeError(error: unknown): boolean {
	const info = extractLarkErrorInfo(error);
	return info.message.toLowerCase().includes("abort");
}

function wasLastAssistantMessageAborted(session: AgentSession): boolean {
	const messages = [...session.state.messages].reverse();
	for (const message of messages) {
		const typedMessage = message as { role?: string; stopReason?: string };
		if (typedMessage.role === "assistant") {
			return typedMessage.stopReason === "aborted";
		}
	}
	return false;
}

async function reply(event: LarkMessageEvent, text: string) {
	return sendTextLark({
		config: config.feishu,
		to: event.message.chat_id,
		text,
	});
}

async function updateReplyText(messageId: string, text: string): Promise<void> {
	await LarkClient.fromConfig(config.feishu).sdk.im.message.update({
		path: { message_id: messageId },
		data: {
			msg_type: "post",
			content: JSON.stringify({
				zh_cn: {
					content: [[{ tag: "md", text }]],
				},
			}),
		},
	});
}

async function addWorkingReaction(messageId: string): Promise<string | undefined> {
	const response = await LarkClient.fromConfig(config.feishu).sdk.im.messageReaction.create({
		path: { message_id: messageId },
		data: {
			reaction_type: {
				emoji_type: WORKING_REACTION,
			},
		},
	});
	return response?.data?.reaction_id;
}

async function removeWorkingReaction(messageId: string, reactionId: string): Promise<void> {
	await LarkClient.fromConfig(config.feishu).sdk.im.messageReaction.delete({
		path: {
			message_id: messageId,
			reaction_id: reactionId,
		},
	});
}

class LarkProgressReporter {
	private reactionId?: string;
	private activeSegment?: AssistantSegment;
	private toolRunImBlock?: ToolRunImBlock;
	private flushTimer?: ReturnType<typeof setTimeout>;
	private pending: Promise<void> = Promise.resolve();
	private visibleResponseStarted = false;

	constructor(private readonly event: LarkMessageEvent) {}

	async markReceived(): Promise<void> {
		try {
			const reactionId = await addWorkingReaction(this.event.message.message_id);
			if (reactionId) {
				this.reactionId = reactionId;
			}
		} catch (error) {
			console.warn(chalk.gray(`Reaction skipped: ${formatLarkError(error)}`));
		}
	}

	onSessionEvent = (event: SessionEvent): void => {
		switch (event.type) {
			case "message_start": {
				const message = event.message as { role?: string };
				if (message.role === "assistant") {
					this.finalizeActiveSegment();
				}
				break;
			}
			case "message_update": {
				const assistantEvent = event.assistantMessageEvent as
					| { type?: string; delta?: string; content?: string }
					| undefined;
				switch (assistantEvent?.type) {
					case "thinking_start":
						this.startSegment("thinking");
						break;
					case "thinking_delta":
						if (assistantEvent.delta) {
							this.appendToSegment("thinking", assistantEvent.delta);
						}
						break;
					case "thinking_end":
						if (assistantEvent.content) {
							this.finishSegment("thinking", assistantEvent.content);
						}
						break;
					case "text_start":
						this.startSegment("assistant");
						break;
					case "text_delta":
						if (assistantEvent.delta) {
							this.appendToSegment("assistant", assistantEvent.delta);
						}
						break;
					case "text_end":
						if (assistantEvent.content) {
							this.finishSegment("assistant", assistantEvent.content);
						}
						break;
				}
				break;
			}
			case "message_end":
				this.finalizeActiveSegment();
				break;
			case "tool_execution_start":
				if (config.outputToolCallsToIm) {
					this.finalizeActiveSegment();
					this.appendToolRunLine(formatToolImLine(event.toolName, event.args));
				}
				break;
			case "tool_execution_end":
				if (config.outputToolCallsToIm && event.isError) {
					this.appendToolRunLine(formatToolImErrorLine(event.toolName, event.result));
				}
				break;
		}
	};

	async finish(finalText: string): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		if (this.activeSegment?.kind === "assistant") {
			const normalizedFinalText = finalText.trim();
			if (normalizedFinalText) {
				this.activeSegment.content = normalizedFinalText;
			}
		}
		this.finalizeActiveSegment();

		await this.pending;
		await this.clearReaction();
	}

	async fail(errorMessage: string): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		await this.clearReaction();
		await reply(this.event, `Failed: ${errorMessage}`);
	}

	async dispose(): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		await this.pending;
		await this.clearReaction();
	}

	private startSegment(kind: AssistantSegment["kind"]): void {
		if (this.activeSegment?.kind === kind) {
			return;
		}
		this.finalizeActiveSegment();
		if (kind === "assistant") {
			const orphanedToolBlock = this.toolRunImBlock;
			this.toolRunImBlock = undefined;
			if (orphanedToolBlock?.content.trim()) {
				this.enqueue(() => this.pushToolRunBlock(orphanedToolBlock));
			}
		}
		this.activeSegment = {
			kind,
			content: "",
			messagePrefix: "",
			messageEditCount: 0,
			lastRendered: "",
		};
	}

	private appendToSegment(kind: AssistantSegment["kind"], delta: string): void {
		if (!this.activeSegment || this.activeSegment.kind !== kind) {
			this.startSegment(kind);
		}
		if (!this.activeSegment) {
			return;
		}
		this.activeSegment.content += delta;
		this.scheduleFlush();
	}

	private finishSegment(kind: AssistantSegment["kind"], content: string): void {
		if (!this.activeSegment || this.activeSegment.kind !== kind) {
			this.startSegment(kind);
		}
		if (!this.activeSegment) {
			return;
		}
		this.activeSegment.content = content;
		this.finalizeActiveSegment();
	}

	private scheduleFlush(): void {
		if (this.flushTimer) {
			return;
		}

		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.flushActiveSegment();
		}, STREAM_UPDATE_DEBOUNCE_MS);
	}

	private renderSegment(segment: AssistantSegment): string {
		if (segment.kind === "thinking") {
			return toQuotedMarkdown("Thinking", truncate(segment.content.trim(), 3000));
		}
		return segment.content.trim();
	}

	private flushActiveSegment(): void {
		const segment = this.activeSegment;
		if (!segment) {
			return;
		}
		this.enqueue(() => this.pushSegment(segment));
	}

	private finalizeActiveSegment(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		const segment = this.activeSegment;
		this.activeSegment = undefined;
		if (!segment || !segment.content.trim()) {
			return;
		}
		this.enqueue(async () => {
			await this.pushSegment(segment);
		});
	}

	private async pushSegment(segment: AssistantSegment): Promise<void> {
		const rendered = this.renderSegment(segment).trim();
		if (!rendered || rendered === segment.lastRendered) {
			return;
		}

		await this.beginVisibleResponse();
		let currentChunk = getContinuationText(rendered, segment.messagePrefix);
		if (segment.messageId && segment.messageEditCount >= MAX_MESSAGE_EDITS) {
			segment.messageId = undefined;
			segment.messagePrefix = segment.lastRendered;
			segment.messageEditCount = 0;
			currentChunk = getContinuationText(rendered, segment.messagePrefix);
		}
		if (segment.messageId) {
			try {
				await updateReplyText(segment.messageId, currentChunk);
				segment.messageEditCount += 1;
			} catch (error) {
				if (!isMessageEditLimitError(error)) {
					throw error;
				}
				console.warn(chalk.gray("Assistant segment edit limit reached, continuing in a new message."));
				segment.messageId = undefined;
				segment.messagePrefix = segment.lastRendered;
				segment.messageEditCount = 0;
				currentChunk = getContinuationText(rendered, segment.messagePrefix);
			}
		}
		if (!segment.messageId && currentChunk) {
			const result = await reply(this.event, currentChunk);
			if (result.messageId) {
				segment.messageId = result.messageId;
				segment.messagePrefix = rendered.slice(0, rendered.length - currentChunk.length);
				segment.messageEditCount = 0;
			}
		}
		segment.lastRendered = rendered;
	}

	private appendToolRunLine(line: string): void {
		if (!this.toolRunImBlock) {
			this.toolRunImBlock = {
				content: "",
				messagePrefix: "",
				messageEditCount: 0,
				lastRendered: "",
			};
		}
		this.toolRunImBlock.content += (this.toolRunImBlock.content ? "\n\n" : "") + line;
		const block = this.toolRunImBlock;
		this.enqueue(() => this.pushToolRunBlock(block));
	}

	private async pushToolRunBlock(block: ToolRunImBlock): Promise<void> {
		const rendered = block.content.trim();
		if (!rendered || rendered === block.lastRendered) {
			return;
		}

		await this.beginVisibleResponse();
		let currentChunk = getContinuationText(rendered, block.messagePrefix);
		if (block.messageId && block.messageEditCount >= MAX_MESSAGE_EDITS) {
			block.messageId = undefined;
			block.messagePrefix = block.lastRendered;
			block.messageEditCount = 0;
			currentChunk = getContinuationText(rendered, block.messagePrefix);
		}
		if (block.messageId) {
			try {
				await updateReplyText(block.messageId, currentChunk);
				block.messageEditCount += 1;
			} catch (error) {
				if (!isMessageEditLimitError(error)) {
					throw error;
				}
				console.warn(chalk.gray("Tool run IM edit limit reached, continuing in a new message."));
				block.messageId = undefined;
				block.messagePrefix = block.lastRendered;
				block.messageEditCount = 0;
				currentChunk = getContinuationText(rendered, block.messagePrefix);
			}
		}
		if (!block.messageId && currentChunk) {
			const result = await reply(this.event, currentChunk);
			if (result.messageId) {
				block.messageId = result.messageId;
				block.messagePrefix = rendered.slice(0, rendered.length - currentChunk.length);
				block.messageEditCount = 0;
			}
		}
		block.lastRendered = rendered;
	}

	private enqueue(task: () => Promise<void>): void {
		this.pending = this.pending
			.then(task, task)
			.catch((error) => console.warn(chalk.gray(`Lark progress update skipped: ${formatLarkError(error)}`)));
	}

	private async beginVisibleResponse(): Promise<void> {
		if (this.visibleResponseStarted) {
			return;
		}
		this.visibleResponseStarted = true;
		await this.clearReaction();
	}

	private async clearReaction(): Promise<void> {
		if (!this.reactionId) {
			return;
		}

		const reactionId = this.reactionId;
		this.reactionId = undefined;
		try {
			await removeWorkingReaction(this.event.message.message_id, reactionId);
		} catch (error) {
			console.warn(chalk.gray(`Reaction cleanup skipped: ${formatLarkError(error)}`));
		}
	}
}

interface ConversationRequest {
	event: LarkMessageEvent;
	promptText: string;
	reporter: LarkProgressReporter;
	receivedAtMs: number;
	interrupted: boolean;
	resolve: (result: ConversationResult) => void;
	reject: (error: unknown) => void;
}

interface ConversationResult {
	assistantText: string;
	interrupted: boolean;
}

function logTurnTiming(
	conversationKey: string,
	stage: string,
	elapsedMs: number,
	details?: string,
): void {
	if (!config.verboseLogs) {
		return;
	}
	const suffix = details ? ` ${details}` : "";
	console.log(chalk.gray(`> turn_timing ${conversationKey} stage=${stage} elapsed=${elapsedMs}ms${suffix}`));
}

class ConversationController {
	private processing = false;
	private currentRequest?: ConversationRequest;
	private pendingRequest?: ConversationRequest;
	private abortPromise?: Promise<void>;

	constructor(private readonly conversationKey: string) {}

	async submit(event: LarkMessageEvent, promptText: string): Promise<ConversationResult> {
		const reporter = new LarkProgressReporter(event);
		await reporter.markReceived();
		let resolvePromise: (result: ConversationResult) => void = () => undefined;
		let rejectPromise: (error: unknown) => void = () => undefined;
		const completion = new Promise<ConversationResult>((resolve, reject) => {
			resolvePromise = resolve;
			rejectPromise = reject;
		});
		const request: ConversationRequest = {
			event,
			promptText,
			reporter,
			receivedAtMs: Date.now(),
			interrupted: false,
			resolve: resolvePromise,
			reject: rejectPromise,
		};

		if (this.pendingRequest) {
			await this.pendingRequest.reporter.dispose();
			this.pendingRequest.resolve({ assistantText: "", interrupted: true });
		}
		this.pendingRequest = request;

		if (this.processing) {
			if (this.currentRequest) {
				this.currentRequest.interrupted = true;
			}
			await this.interruptCurrentRun();
			return completion;
		}

		void this.processPending();
		return completion;
	}

	private async interruptCurrentRun(): Promise<void> {
		if (this.abortPromise) {
			await this.abortPromise;
			return;
		}
		this.abortPromise = (async () => {
			try {
				const session = await sessionPool.getSession(this.conversationKey);
				if (session.isStreaming) {
					await session.abort();
				}
			} catch (error) {
				console.warn(chalk.gray(`Abort skipped: ${formatLarkError(error)}`));
			}
		})();

		try {
			await this.abortPromise;
		} finally {
			this.abortPromise = undefined;
		}
	}

	private async processPending(): Promise<void> {
		if (this.processing) {
			return;
		}
		this.processing = true;
		try {
			for (;;) {
				const request = this.pendingRequest;
				this.pendingRequest = undefined;
				if (!request) {
					return;
				}
				this.currentRequest = request;
				await this.executeRequest(request);
				this.currentRequest = undefined;
			}
		} finally {
			this.processing = false;
			this.currentRequest = undefined;
		}
	}

	private async executeRequest(request: ConversationRequest): Promise<void> {
		const session = await sessionPool.getSession(this.conversationKey);
		logTurnTiming(this.conversationKey, "session_ready", Date.now() - request.receivedAtMs);
		if (request.interrupted) {
			await request.reporter.dispose();
			request.resolve({ assistantText: "", interrupted: true });
			return;
		}

		const promptStartedAt = Date.now();
		let sawFirstThinkingDelta = false;
		let sawFirstTextDelta = false;
		const onSessionEvent = (event: SessionEvent): void => {
			request.reporter.onSessionEvent(event);
			if (event.type !== "message_update") {
				return;
			}
			const assistantEvent = event.assistantMessageEvent as
				| { type?: string; delta?: string; content?: string }
				| undefined;
			if (!sawFirstThinkingDelta && assistantEvent?.type === "thinking_delta" && assistantEvent.delta) {
				sawFirstThinkingDelta = true;
				logTurnTiming(
					this.conversationKey,
					"first_thinking_delta",
					Date.now() - request.receivedAtMs,
					`since_prompt=${Date.now() - promptStartedAt}ms`,
				);
			}
			if (!sawFirstTextDelta && assistantEvent?.type === "text_delta" && assistantEvent.delta) {
				sawFirstTextDelta = true;
				logTurnTiming(
					this.conversationKey,
					"first_text_delta",
					Date.now() - request.receivedAtMs,
					`since_prompt=${Date.now() - promptStartedAt}ms`,
				);
			}
		};
		const unsubscribe = session.subscribe(onSessionEvent);
		let result: ConversationResult = { assistantText: "", interrupted: true };
		let failure: unknown;
		try {
			logTurnTiming(this.conversationKey, "prompt_start", promptStartedAt - request.receivedAtMs);
			await session.prompt(request.promptText);
			if (!request.interrupted && !wasLastAssistantMessageAborted(session)) {
				const responseText = extractAssistantText(session);
				await request.reporter.finish(responseText);
				logTurnTiming(
					this.conversationKey,
					"prompt_complete",
					Date.now() - request.receivedAtMs,
					`since_prompt=${Date.now() - promptStartedAt}ms`,
				);
				result = { assistantText: responseText, interrupted: false };
			}
		} catch (error) {
			if (!request.interrupted && !isAbortLikeError(error)) {
				const errorMessage = formatLarkError(error);
				logTurnTiming(
					this.conversationKey,
					"prompt_error",
					Date.now() - request.receivedAtMs,
					`since_prompt=${Date.now() - promptStartedAt}ms`,
				);
				console.error(chalk.red(`Error: ${errorMessage}`));
				await request.reporter.fail(errorMessage);
				failure = error;
			}
		} finally {
			unsubscribe();
			await request.reporter.dispose();
			if (failure !== undefined) {
				request.reject(failure);
				return;
			}
			request.resolve(result);
		}
	}
}

function getConversationController(conversationKey: string): ConversationController {
	let controller = conversations.get(conversationKey);
	if (!controller) {
		controller = new ConversationController(conversationKey);
		conversations.set(conversationKey, controller);
	}
	return controller;
}

async function handleMessageEvent(event: LarkMessageEvent, botOpenId: string | undefined): Promise<void> {
	const messageId = event.message.message_id;
	if (!dedup.record(messageId)) {
		return;
	}
	if (!isRecentMessage(event, config.startedAtMs)) {
		return;
	}
	if (!shouldHandleMessage(event, botOpenId)) {
		return;
	}
	const promptText = extractPromptText(event, botOpenId);
	if (!promptText) {
		await reply(event, "Only text messages are supported.");
		return;
	}

	const conversationKey = getConversationKey(event);
	const controller = getConversationController(conversationKey);
	await controller.submit(event, promptText);
}

async function main(): Promise<void> {
	mkdirSync(config.homeDir, { recursive: true });

	const client = LarkClient.fromConfig(config.feishu);
	const probe = await client.probe();
	if (!probe.ok) {
		const hint =
			" Often: wrong App ID / App Secret, or Feishu (China) vs Lark (international) does not match where the app was created, or bot capability is off. Logs above may show token errors.";
		throw new Error(`Lark probe failed: ${probe.error ?? "unknown error"}.${hint}`);
	}
	currentBotOpenId = client.botOpenId;
	larkClientForShutdown = client;

	printStartupSummary();

	process.on("SIGINT", () => {
		sigintCount += 1;
		if (sigintCount >= 2) {
			console.error("\n[pi-feishu] Second interrupt: forcing exit.");
			process.exit(130);
		}
		shutdownExitCode = 130;
		larkClientForShutdown?.disconnect();
		abortController.abort();
		armForceExitAfterInterrupt(130);
	});
	process.on("SIGTERM", () => {
		shutdownExitCode = 143;
		larkClientForShutdown?.disconnect();
		abortController.abort();
		armForceExitAfterInterrupt(143);
	});

	try {
		await client.startWS({
			abortSignal: abortController.signal,
			handlers: {
				"im.message.receive_v1": async (data: unknown) => {
					await handleMessageEvent(data as LarkMessageEvent, client.botOpenId);
				},
			},
		});
	} finally {
		larkClientForShutdown = undefined;
		disarmForceExitAfterInterrupt();
	}
}

try {
	await main();
} catch (error) {
	if (shutdownExitCode === 0) {
		shutdownExitCode = 1;
	}
	console.error(error instanceof Error ? error.message : error);
} finally {
	disarmForceExitAfterInterrupt();
}
process.exit(shutdownExitCode);
