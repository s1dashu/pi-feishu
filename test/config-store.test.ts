import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getConfigStorePath,
	loadConfigStore,
	mergeConfigStoreEnv,
	saveConfigStore,
	setOwnerSessionBinding,
	setStoredProfile,
	type PiFeishuConfigStore,
} from "../src/core/config-store.js";

describe("mergeConfigStoreEnv", () => {
	it("merges, deletes on empty, and drops env when no keys left", () => {
		const base: PiFeishuConfigStore = {
			version: 2,
			env: { X: "1", Y: "2" },
		};
		const next = mergeConfigStoreEnv(base, { Y: "", Z: "3" });
		expect(next.env).toEqual({ X: "1", Z: "3" });
		const cleared = mergeConfigStoreEnv(next, { X: "", Z: "" });
		expect(cleared.env).toBeUndefined();
	});
});

describe("setStoredProfile / setOwnerSessionBinding", () => {
	it("preserves unrelated fields", () => {
		const store: PiFeishuConfigStore = {
			version: 2,
			ownerSession: { chatId: "c1", sessionKey: "s1" },
			env: { K: "v" },
		};
		const profile = {
			channel: { kind: "feishu" as const, appId: "app" },
			model: { provider: "openai" },
		};
		const withProfile = setStoredProfile(store, profile);
		expect(withProfile.profile).toEqual(profile);
		expect(withProfile.ownerSession).toEqual(store.ownerSession);
		expect(withProfile.env).toEqual(store.env);

		const withOwner = setOwnerSessionBinding(withProfile, {
			chatId: "c2",
			sessionKey: "c2",
		});
		expect(withOwner.ownerSession?.chatId).toBe("c2");
		expect(withOwner.profile).toEqual(profile);
	});
});

describe("loadConfigStore with temp home", () => {
	let dir: string;
	let prevHome: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-feishu-cfg-"));
		prevHome = process.env.PI_FEISHU_HOME;
		process.env.PI_FEISHU_HOME = dir;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		if (prevHome === undefined) {
			delete process.env.PI_FEISHU_HOME;
		} else {
			process.env.PI_FEISHU_HOME = prevHome;
		}
	});

	it("reads config.json profile and env", () => {
		mkdirSync(dir, { recursive: true });
		const cfg = {
			version: 2,
			profile: {
				channel: { kind: "feishu", appId: "my-app" },
				model: { provider: "x", model: "m1" },
			},
			env: { API: "k" },
		};
		writeFileSync(join(dir, "config.json"), JSON.stringify(cfg), "utf8");
		const loaded = loadConfigStore();
		expect(loaded.profile?.channel.appId).toBe("my-app");
		expect(loaded.profile?.model.model).toBe("m1");
		expect(loaded.env).toEqual({ API: "k" });
		expect(getConfigStorePath()).toBe(join(dir, "config.json"));
	});

	it("returns default store when file is absent", () => {
		expect(loadConfigStore()).toEqual({ version: 2 });
	});
});

describe("saveConfigStore", () => {
	let dir: string;
	let prevHome: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-feishu-save-"));
		prevHome = process.env.PI_FEISHU_HOME;
		process.env.PI_FEISHU_HOME = dir;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		if (prevHome === undefined) {
			delete process.env.PI_FEISHU_HOME;
		} else {
			process.env.PI_FEISHU_HOME = prevHome;
		}
	});

	it("writes JSON to config path", () => {
		const store: PiFeishuConfigStore = { version: 2, env: { A: "b" } };
		saveConfigStore(store);
		const raw = JSON.parse(readFileSync(getConfigStorePath(), "utf8"));
		expect(raw.version).toBe(2);
		expect(raw.env).toEqual({ A: "b" });
	});
});
