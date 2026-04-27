import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	expandUserHomePath,
	getAgentEnvFilePath,
	readAgentEnvFile,
	resolveAgentHomeDir,
	shellExportPiFeishuHome,
	shortenHomeInPath,
	upsertAgentEnv,
} from "../src/core/agent-home.js";

describe("readAgentEnvFile", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-feishu-test-"));
		file = join(dir, ".env");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns {} for missing file", () => {
		expect(readAgentEnvFile(file)).toEqual({});
	});

	it("skips comments and blank lines", () => {
		writeFileSync(
			file,
			`
# comment
FOO=bar

  # indented comment
BAZ=qux
`,
			"utf8",
		);
		expect(readAgentEnvFile(file)).toEqual({ FOO: "bar", BAZ: "qux" });
	});

	it("supports export prefix and JSON-quoted values", () => {
		writeFileSync(
			file,
			['export HELLO=world', `QUOTED=${JSON.stringify("a b")}`].join("\n"),
			"utf8",
		);
		expect(readAgentEnvFile(file)).toEqual({ HELLO: "world", QUOTED: "a b" });
	});
});

describe("getAgentEnvFilePath", () => {
	it("joins home with .env", () => {
		const home = join("data", "agent");
		expect(getAgentEnvFilePath(home)).toBe(join(home, ".env"));
	});
});

describe("upsertAgentEnv", () => {
	let dir: string;
	let prevHome: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-feishu-env-"));
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

	it("writes sorted keys as JSON-encoded values and removes cleared keys", () => {
		upsertAgentEnv({ A: "1", B: "two" }, dir);
		upsertAgentEnv({ B: "", C: "3" }, dir);
		const text = readFileSync(join(dir, ".env"), "utf8");
		expect(text.trim().split("\n")).toEqual(['A="1"', 'C="3"']);
	});
});

describe("shortenHomeInPath / expandUserHomePath / shellExportPiFeishuHome", () => {
	it("round-trips ~/.pi-feishu style", () => {
		const abs = join(homedir(), ".pi-feishu");
		expect(shortenHomeInPath(abs)).toBe("~/.pi-feishu");
		expect(expandUserHomePath("~/.pi-feishu")).toBe(abs);
	});

	it("treats fullwidth tilde (U+FF5E) like ASCII ~ for home expansion", () => {
		const rel = ".pi-feishu-fw-test";
		const abs = join(homedir(), rel);
		expect(expandUserHomePath(`\uFF5E/${rel}`)).toBe(abs);
	});

	it("shellExport uses $HOME when under user home", () => {
		const abs = join(homedir(), ".pi-feishu", "nested");
		expect(shellExportPiFeishuHome(abs)).toMatch(/^export PI_FEISHU_HOME="\$HOME\//);
	});
});

describe("resolveAgentHomeDir", () => {
	const prev = process.env.PI_FEISHU_HOME;

	afterEach(() => {
		if (prev === undefined) {
			delete process.env.PI_FEISHU_HOME;
		} else {
			process.env.PI_FEISHU_HOME = prev;
		}
	});

	it("uses PI_FEISHU_HOME when set", () => {
		process.env.PI_FEISHU_HOME = "/custom/home";
		expect(resolveAgentHomeDir()).toMatch(/\/custom\/home$/);
	});
});
