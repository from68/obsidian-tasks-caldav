import { App } from "obsidian";

let DEBUG = false;

const LOG_FILE_PATH = ".obsidian/plugins/obsidian-tasks-caldev/sync.log";
const MAX_LINES = 10_000;
const BUFFER_CAP = 2_000;
const FLUSH_INTERVAL_MS = 5_000;

class FileLogger {
	private app: App | null = null;
	private buffer: string[] = [];
	private flushTimer: number | null = null;
	private flushing = false;

	init(app: App): void {
		this.app = app;
	}

	append(level: string, message: string, extra?: unknown): void {
		if (!DEBUG) return;
		const timestamp = new Date().toISOString();
		let entry = `[${timestamp}] [${level}] ${message}`;
		if (extra !== undefined) {
			entry += ` ${serializeExtra(extra)}`;
		}
		this.buffer.push(entry);
		if (this.buffer.length >= BUFFER_CAP) {
			void this.flush();
		} else {
			this.scheduleFlush();
		}
	}

	private scheduleFlush(): void {
		if (this.flushTimer !== null) return;
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			void this.flush();
		}, FLUSH_INTERVAL_MS);
	}

	async flush(): Promise<void> {
		if (!this.app || this.buffer.length === 0 || this.flushing) return;
		this.flushing = true;
		const entries = this.buffer.splice(0);
		try {
			const adapter = this.app.vault.adapter;
			let existingLines: string[] = [];
			try {
				const content = await adapter.read(LOG_FILE_PATH);
				existingLines = content.split("\n").filter((l) => l.length > 0);
			} catch {
				// File doesn't exist yet — start fresh
			}
			const allLines = [...existingLines, ...entries];
			const trimmed =
				allLines.length > MAX_LINES
					? allLines.slice(allLines.length - MAX_LINES)
					: allLines;
			await adapter.write(LOG_FILE_PATH, trimmed.join("\n") + "\n");
		} finally {
			this.flushing = false;
		}
	}

	async shutdown(): Promise<void> {
		if (this.flushTimer !== null) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		await this.flush();
	}
}

function serializeExtra(extra: unknown): string {
	if (extra instanceof Error) {
		return extra.stack ?? `${extra.name}: ${extra.message}`;
	}
	if (Array.isArray(extra) && extra.length === 0) return "";
	try {
		return JSON.stringify(extra);
	} catch {
		return String(extra);
	}
}

const fileLogger = new FileLogger();

export function initLogger(app: App): void {
	fileLogger.init(app);
}

export async function shutdownLogger(): Promise<void> {
	await fileLogger.shutdown();
}

export function setDebugMode(enabled: boolean): void {
	DEBUG = enabled;
}

export class Logger {
	static info(message: string, ...args: unknown[]): void {
		fileLogger.append("INFO", message, args.length ? args : undefined);
	}

	static warn(message: string, ...args: unknown[]): void {
		fileLogger.append("WARN", message, args.length ? args : undefined);
	}

	static error(message: string, error?: unknown): void {
		if (error !== undefined) {
			console.error(`[CalDAV Sync] ${message}`, error);
		} else {
			console.error(`[CalDAV Sync] ${message}`);
		}
		fileLogger.append("ERROR", message, error);
	}

	static debug(message: string, ...args: unknown[]): void {
		fileLogger.append("DEBUG", message, args.length ? args : undefined);
	}

	static taskInfo(blockId: string, message: string): void {
		Logger.debug(`Task ${blockId}: ${message}`);
	}

	static syncStats(stats: {
		total: number;
		synced: number;
		filtered: number;
		errors: number;
	}): void {
		Logger.info(
			`Sync stats: ${stats.synced}/${stats.total} tasks synced, ${stats.filtered} filtered, ${stats.errors} errors`,
		);
	}

	static syncStart(): void {
		Logger.info("Sync started...");
	}

	static syncComplete(): void {
		Logger.info("Sync completed.");
	}
}
