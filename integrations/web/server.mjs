#!/usr/bin/env node
/**
 * PolanClaw Web —— 最小、安全的 HTTP + 网页聊天入口
 *
 * 设计要点
 * - 只使用 Node.js 内置 node:http，无第三方 Web 依赖
 * - 仅监听 127.0.0.1；端口取 PORT（默认 5000）
 * - 启动强制要求 POLANCLAW_WEB_TOKEN，否则拒绝启动；POST /api/message
 *   校验 Authorization: Bearer <token>（常数时间比较）
 * - Agent 工作目录取 POLANCLAW_CWD（默认本仓库根目录）
 * - 第一版只启用只读工具 read / grep / find / ls，不启用 bash / write / edit；
 *   资源加载器为空，避免把全局/项目扩展、技能、命令暴露给网络请求
 * - 使用 @earendil-works/pi-coding-agent SDK：
 *   ModelRuntime.create() / createAgentSession() / SessionManager.inMemory() /
 *   session.subscribe()（收集 message_update/text_delta）/ session.prompt()
 * - 并发限制：同一时间只允许一个 Agent 请求，其余返回 409
 * - 请求体与消息长度限制；安全响应头；错误处理与 SIGINT/SIGTERM 优雅退出
 * - 不读取/修改 .env，不把 Token 或 API Key 写入源码
 *
 * 用法
 *   POLANCLAW_WEB_TOKEN=<token> [PORT=5000] [POLANCLAW_CWD=<dir>] [POLANCLAW_MODEL=provider/modelId] \
 *     node integrations/web/server.mjs
 *
 * 可选 POLANCLAW_MODEL 用于显式指定模型（如 POLANCLAW_MODEL=openai/deepseek-v4-flash）；
 * 未设置时自动选择：优先取模型运行时中已配置认证的默认/首个可用模型。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
	createExtensionRuntime,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 常量与启动前校验
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const INDEX_FILE = join(__dirname, "public", "index.html");

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT ?? "5000", 10);
const MAX_BODY_BYTES = 64 * 1024; // 请求体上限：64 KiB
const MAX_MESSAGE_CHARS = 8000; // 单条用户消息上限
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

const MODEL_OVERRIDE = process.env.POLANCLAW_MODEL ?? ""; // 可选：provider/modelId
const WEB_TOKEN = process.env.POLANCLAW_WEB_TOKEN ?? "";
if (WEB_TOKEN.length === 0) {
	console.error("[web] 拒绝启动：缺少环境变量 POLANCLAW_WEB_TOKEN。");
	console.error("[web] 示例: POLANCLAW_WEB_TOKEN=<token> node integrations/web/server.mjs");
	process.exit(1);
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
	console.error(`[web] 拒绝启动：PORT 无效（${process.env.PORT ?? ""}）。`);
	process.exit(1);
}

const CWD = resolve(process.env.POLANCLAW_CWD ?? REPO_ROOT);
try {
	if (!statSync(CWD).isDirectory()) throw new Error("not a directory");
} catch {
	console.error(`[web] 拒绝启动：POLANCLAW_CWD 不是有效目录：${CWD}`);
	process.exit(1);
}

let indexHtml;
try {
	indexHtml = await readFile(INDEX_FILE, "utf8");
} catch {
	console.error(`[web] 拒绝启动：无法读取页面文件 ${INDEX_FILE}`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Agent 初始化（只读会话，空资源加载器 = 无扩展 / 无技能 / 无命令 / 无上下文文件）
// ---------------------------------------------------------------------------

const systemPrompt = [
	`You are PolanClaw, a read-only coding assistant served over a local web chat.`,
	`Working directory (POLANCLAW_CWD): ${CWD}`,
	"Tools available: read, grep, find, ls. You CANNOT modify files, run shell commands, or execute code.",
	"Inspect the repository with these tools and answer accurately. When the user asks for a change, " +
		"explain precisely how to make it as text — never claim that you applied it.",
	"Answer in the same language the user writes in. Be concise.",
].join("\n");

/** 最小化 ResourceLoader：不加载任何扩展、技能、提示模板、主题、上下文文件。 */
function createReadOnlyResourceLoader() {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

console.log("[web] 正在初始化模型运行时与只读 Agent 会话…");
const modelRuntime = await ModelRuntime.create();

let modelOption;
if (MODEL_OVERRIDE) {
	const separator = MODEL_OVERRIDE.indexOf("/");
	if (separator <= 0 || separator === MODEL_OVERRIDE.length - 1) {
		console.error(`[web] 拒绝启动：POLANCLAW_MODEL 无效，应为 provider/modelId（如 openai/deepseek-v4-flash）。`);
		process.exit(1);
	}
	modelOption = modelRuntime.getModel(MODEL_OVERRIDE.slice(0, separator), MODEL_OVERRIDE.slice(separator + 1));
	if (!modelOption) {
		console.error(`[web] 拒绝启动：POLANCLAW_MODEL 指定的模型不存在：${MODEL_OVERRIDE}`);
		process.exit(1);
	}
}

const { session, modelFallbackMessage } = await createAgentSession({
	cwd: CWD,
	modelRuntime,
	...(modelOption ? { model: modelOption } : {}),
	tools: READ_ONLY_TOOLS,
	resourceLoader: createReadOnlyResourceLoader(),
	sessionManager: SessionManager.inMemory(CWD),
	settingsManager: SettingsManager.inMemory({}),
});

if (!session.model) {
	console.error("[web] 拒绝启动：没有可用模型。请先配置模型认证（如 ANTHROPIC_API_KEY / OPENAI_API_KEY 环境变量，或 ~/.pi/agent 中的认证）。");
	if (modelFallbackMessage) console.error(`[web] ${modelFallbackMessage}`);
	session.dispose();
	process.exit(1);
}

console.log(`[web] 模型: ${session.model.provider}/${session.model.id}（thinking: ${session.thinkingLevel}）`);
console.log(`[web] 工具: ${session.getActiveToolNames().join(", ")}`);

// ---------------------------------------------------------------------------
// 订阅：收集 message_update / text_delta。并发由 busy 串行化，单次运行互不干扰。
// ---------------------------------------------------------------------------

const run = { active: false, text: "" };
session.subscribe((event) => {
	try {
		if (!run.active || event?.type !== "message_update") return;
		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
			run.text += assistantEvent.delta;
		}
	} catch (err) {
		console.error("[web] 事件订阅处理出错:", err);
	}
});

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------

const CSP = [
	"default-src 'self'",
	"script-src 'unsafe-inline'",
	"style-src 'unsafe-inline'",
	"connect-src 'self'",
	"img-src 'self' data:",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join("; ");

function applySecurityHeaders(res) {
	res.setHeader("Content-Security-Policy", CSP);
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("X-Frame-Options", "DENY");
	res.setHeader("Referrer-Policy", "no-referrer");
	res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
	res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
	res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
	res.setHeader("Cache-Control", "no-store");
}

function sendJson(res, status, payload) {
	applySecurityHeaders(res);
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
	});
	res.end(body);
}

function sendHtml(res, html) {
	applySecurityHeaders(res);
	const body = Buffer.from(html, "utf8");
	res.writeHead(200, {
		"Content-Type": "text/html; charset=utf-8",
		"Content-Length": body.length,
	});
	res.end(body);
}

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

/** 读取请求体并限制大小；超限时排空剩余数据后报 413，保证 keep-alive 连接可复用。 */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let overflowed = false;
		req.on("data", (chunk) => {
			if (overflowed) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				overflowed = true;
				chunks.length = 0;
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (overflowed) {
				reject(new HttpError(413, `请求体过大（上限 ${MAX_BODY_BYTES} 字节）。`));
				return;
			}
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", reject);
	});
}

/** 常数时间比较 Bearer token，避免长度与内容侧信道。 */
function tokenMatches(provided) {
	const expectedDigest = createHash("sha256").update(WEB_TOKEN).digest();
	const providedDigest = createHash("sha256").update(provided).digest();
	return timingSafeEqual(expectedDigest, providedDigest);
}

function extractBearerToken(req) {
	const header = req.headers.authorization;
	if (typeof header !== "string") return null;
	const space = header.indexOf(" ");
	if (space <= 0) return null;
	const scheme = header.slice(0, space).trim();
	const token = header.slice(space + 1).trim();
	if (scheme.toLowerCase() !== "bearer" || token.length === 0) return null;
	return token;
}

/** 提取助手消息中的纯文本内容（丢弃 thinking 与 toolCall 部分）。 */
function assistantText(msg) {
	const parts = Array.isArray(msg?.content) ? msg.content : [];
	const texts = [];
	for (const part of parts) {
		if (part && part.type === "text" && typeof part.text === "string") texts.push(part.text);
	}
	return texts.join("\n");
}

/** 运行一次 Agent 对话，返回最终文本回复。 */
async function runChat(userText) {
	const beforeCount = session.messages.length;
	run.active = true;
	run.text = "";
	try {
		await session.prompt(userText);
	} finally {
		run.active = false;
	}

	const afterCount = session.messages.length;
	const newMessages = afterCount > beforeCount ? session.messages.slice(beforeCount) : [];
	const assistantMessages = newMessages.filter((msg) => msg && msg.role === "assistant");
	const last = assistantMessages[assistantMessages.length - 1];

	if (last && (last.stopReason === "error" || last.stopReason === "aborted")) {
		throw new HttpError(502, `Agent 执行失败：${last.errorMessage ?? last.stopReason}`);
	}

	const answer = last ? assistantText(last).trim() : "";
	if (answer) return answer;

	// 兜底：某些流式实现只有 text_delta 而无最终文本消息
	const deltaText = run.text.trim();
	if (deltaText) return deltaText;

	if (last) return "";
	throw new HttpError(502, "Agent 未产生任何回复。");
}

// ---------------------------------------------------------------------------
// 状态与路由
// ---------------------------------------------------------------------------

let busy = false;
let shuttingDown = false;

function handleHealth(res) {
	sendJson(res, 200, {
		status: "ok",
		pid: process.pid,
		uptime: Number(process.uptime().toFixed(2)),
		busy,
		cwd: CWD,
		model: session.model ? `${session.model.provider}/${session.model.id}` : null,
		tools: session.getActiveToolNames(),
	});
}

async function handleMessage(req, res) {
	if (shuttingDown) throw new HttpError(503, "服务正在关闭。");
	if (busy) throw new HttpError(409, "已有 Agent 请求在处理中，请稍后重试。");

	const token = extractBearerToken(req);
	if (!token || !tokenMatches(token)) throw new HttpError(401, "未授权：缺少或错误的 Bearer Token。");

	const contentType = req.headers["content-type"] ?? "";
	if (!/^application\/json\b/i.test(contentType)) {
		throw new HttpError(415, "Content-Type 必须为 application/json。");
	}

	busy = true;
	try {
		const raw = await readBody(req);
		let data;
		try {
			data = JSON.parse(raw);
		} catch {
			throw new HttpError(400, "请求体不是合法的 JSON。");
		}
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			throw new HttpError(400, "请求体必须是 JSON 对象，如 {\"text\":\"...\"}。");
		}

		const text = typeof data.text === "string" ? data.text.trim() : "";
		if (!text) throw new HttpError(400, "缺少非空字段 'text'。");
		if (text.length > MAX_MESSAGE_CHARS) {
			throw new HttpError(400, `'text' 超过 ${MAX_MESSAGE_CHARS} 字符上限。`);
		}

		const answer = await runChat(text);
		sendJson(res, 200, { text: answer });
	} finally {
		busy = false;
	}
}

function sendMethodNotAllowed(res, allow) {
	res.setHeader("Allow", allow);
	sendJson(res, 405, { error: "方法不允许。" });
}

async function route(req, res) {
	res.on("error", () => {}); // 客户端断开等写错误不向上抛
	const start = Date.now();
	res.on("finish", () => {
		console.log(`[web] ${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - start}ms)`);
	});

	let pathname = "/";
	try {
		pathname = new URL(req.url ?? "/", `http://${HOST}`).pathname;
	} catch {
		/* 保留默认值 */
	}

	try {
		if (pathname === "/health" && req.method === "GET") return handleHealth(res);
		if (pathname === "/health") return sendMethodNotAllowed(res, "GET");

		if (pathname === "/" && req.method === "GET") return sendHtml(res, indexHtml);
		if (pathname === "/") return sendMethodNotAllowed(res, "GET");

		if (pathname === "/api/message" && req.method === "POST") return await handleMessage(req, res);
		if (pathname === "/api/message") return sendMethodNotAllowed(res, "POST");

		sendJson(res, 404, { error: "未找到该路径。" });
	} catch (err) {
		if (res.headersSent || res.writableEnded) {
			console.error("[web] 响应已开始后出错:", err);
			try {
				res.destroy();
			} catch {
				/* ignore */
			}
			return;
		}
		if (err instanceof HttpError) {
			sendJson(res, err.status, { error: err.message });
			return;
		}
		console.error("[web] 请求处理异常:", err);
		sendJson(res, shuttingDown ? 503 : 500, {
			error: shuttingDown ? "服务正在关闭。" : "服务器内部错误。",
		});
	}
}

const server = createServer((req, res) => {
	route(req, res).catch((err) => {
		console.error("[web] 路由异常:", err);
		try {
			if (!res.headersSent && !res.writableEnded) sendJson(res, 500, { error: "服务器内部错误。" });
		} catch {
			/* ignore */
		}
	});
});

// ---------------------------------------------------------------------------
// 启动与优雅退出
// ---------------------------------------------------------------------------

server.listen(PORT, HOST, () => {
	console.log(`[web] 聊天服务已启动：http://${HOST}:${PORT}`);
	console.log(`[web] 工作目录（POLANCLAW_CWD）：${CWD}`);
	console.log(`[web] 健康检查：GET http://${HOST}:${PORT}/health`);
	console.log(`[web] 停止：按 Ctrl+C（SIGINT / SIGTERM 优雅退出）`);
});

async function shutdown(signal) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[web] 收到 ${signal}，正在优雅退出…`);

	server.close();
	try {
		server.closeIdleConnections?.();
	} catch {
		/* ignore */
	}

	if (busy) {
		try {
			await session.abort();
		} catch {
			/* ignore */
		}
	}
	try {
		session.dispose();
	} catch {
		/* ignore */
	}

	const forceTimer = setTimeout(() => {
		console.error("[web] 优雅退出超时，强制退出。");
		process.exit(1);
	}, 8000);
	forceTimer.unref?.();

	await new Promise((resolvePromise) => {
		server.once("close", resolvePromise);
		setTimeout(resolvePromise, 1500).unref?.();
	});
	try {
		server.closeAllConnections?.();
	} catch {
		/* ignore */
	}
	clearTimeout(forceTimer);
	console.log("[web] 已退出。");
	// 等 stdout 缓冲写完再退出，避免丢失最后的日志
	const exitTimer = setTimeout(() => process.exit(0), 2000);
	exitTimer.unref?.();
	process.stdout.write("", () => {
		clearTimeout(exitTimer);
		process.exit(0);
	});
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
	console.error("[web] unhandledRejection:", reason);
});
