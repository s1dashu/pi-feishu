import { describe, expect, it } from "vitest";
import { normalizeOpenAiCompatibleBaseUrl, normalizeOpenAiResponsesBaseUrl } from "../src/onboard.js";

describe("normalizeOpenAiCompatibleBaseUrl", () => {
	it("keeps the user-provided base URL without adding API path segments", () => {
		expect(normalizeOpenAiCompatibleBaseUrl("https://api.example.com")).toBe("https://api.example.com");
		expect(normalizeOpenAiCompatibleBaseUrl("https://api.example.com/")).toBe("https://api.example.com");
	});

	it("keeps explicit /v1 when the user provides it", () => {
		expect(normalizeOpenAiCompatibleBaseUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1");
		expect(normalizeOpenAiCompatibleBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
	});

	it("handles empty", () => {
		expect(normalizeOpenAiCompatibleBaseUrl("")).toBe("");
		expect(normalizeOpenAiCompatibleBaseUrl("  ")).toBe("");
	});
});

describe("normalizeOpenAiResponsesBaseUrl", () => {
	it("keeps the user-provided base URL without changing path semantics", () => {
		expect(normalizeOpenAiResponsesBaseUrl("https://api.example.com")).toBe("https://api.example.com");
		expect(normalizeOpenAiResponsesBaseUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1");
		expect(normalizeOpenAiResponsesBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
	});

	it("keeps explicit /responses when the user provides it", () => {
		expect(normalizeOpenAiResponsesBaseUrl("https://api.example.com/v1/responses")).toBe("https://api.example.com/v1/responses");
		expect(normalizeOpenAiResponsesBaseUrl("https://api.example.com/v1/responses/")).toBe("https://api.example.com/v1/responses");
	});

	it("handles empty", () => {
		expect(normalizeOpenAiResponsesBaseUrl("")).toBe("");
		expect(normalizeOpenAiResponsesBaseUrl("  ")).toBe("");
	});
});
