/**
 * CalDAV client wrapper using tsdav
 * Based on contracts/caldav-api.md specification
 * Implements T072: Comprehensive error handling
 * Implements T073: Retry logic with exponential backoff
 */

import { App } from "obsidian";
import { DAVClient, DAVCalendar } from "tsdav";
import { CalDAVConfiguration, CalDAVTask, DiscoveredCalendar, VTODOStatus } from "../types";
import {
	CalDAVError,
	CalDAVAuthError,
	CalDAVNetworkError,
	CalDAVConflictError,
	CalDAVServerError,
	CalDAVTimeoutError,
} from "./errors";
import { withRetry } from "./retry";
import { Logger } from "../sync/logger";
import { updateVTODOProperties, escapeICalText } from "./vtodo";

/**
 * CalDAV filter structure for querying tasks
 */
interface CalDAVFilter {
	"comp-filter": {
		_attributes: { name: string };
		"comp-filter"?: {
			_attributes: { name: string };
			"prop-filter"?: {
				_attributes: { name: string };
				"time-range"?: {
					_attributes: { start?: string; end?: string };
				};
			};
		};
	};
}

/**
 * Minimal tsdav client interface for our needs
 */
interface MinimalDAVClient {
	fetchCalendars: () => Promise<DAVCalendar[]>;
	fetchCalendarObjects: (params: {
		calendar: DAVCalendar;
		filters?: CalDAVFilter;
	}) => Promise<Array<{ url: string; data: string; etag?: string }>>;
	createCalendarObject: (params: {
		calendar: DAVCalendar;
		filename: string;
		iCalString: string;
	}) => Promise<{ url: string; etag?: string }>;
	updateCalendarObject: (params: {
		calendarObject: { url: string; data: string; etag: string };
	}) => Promise<{ url: string; etag?: string }>;
	deleteCalendarObject: (params: {
		calendarObject: { url: string; etag: string };
	}) => Promise<void>;
}

/**
 * CalDAV client for task synchronization
 */
export class CalDAVClient {
	private client: MinimalDAVClient | null = null;
	/** All discovered calendars, keyed by exact URL */
	private calendars: Map<string, DAVCalendar> = new Map();
	private config: CalDAVConfiguration;
	private app: App;

	constructor(app: App, config: CalDAVConfiguration) {
		this.app = app;
		this.config = config;
	}

	/**
	 * Resolve a calendar by exact URL, throwing if not found
	 */
	private getCalendar(url: string): DAVCalendar {
		const cal = this.calendars.get(url);
		if (!cal) {
			throw new CalDAVError(
				`Calendar not found in discovery cache: ${url}. Run "Discover calendars" to refresh.`,
			);
		}
		return cal;
	}

	/**
	 * Discover all VTODO-supporting calendars on this server.
	 * Logs in, calls fetchCalendars(), filters client-side by VTODO support
	 * (includes when `components` is absent — false positive beats false negative).
	 */
	async discoverCalendars(): Promise<DiscoveredCalendar[]> {
		const password = this.app.secretStorage.getSecret(this.config.password);
		if (!password) {
			throw new CalDAVAuthError(
				"Password not found in secure storage. Please configure your CalDAV password in settings.",
			);
		}

		const davClient = new DAVClient({
			serverUrl: this.config.serverUrl,
			credentials: { username: this.config.username, password },
			authMethod: "Basic",
			defaultAccountType: "caldav",
		});

		try {
			await davClient.login();
		} catch (error) {
			throw this.handleConnectionError(error);
		}

		const rawCalendars = await (davClient as unknown as MinimalDAVClient).fetchCalendars();

		Logger.debug(`Discovered ${rawCalendars?.length ?? 0} calendars on server`);

		const discovered: DiscoveredCalendar[] = [];
		for (const cal of rawCalendars ?? []) {
			const components: string[] | undefined = (cal as unknown as { components?: string[] }).components;
			const supportsVTODO = !components || components.includes("VTODO");
			if (!supportsVTODO) continue;

			const displayName =
				typeof cal.displayName === "string" && cal.displayName
					? cal.displayName
					: cal.url.split("/").filter(Boolean).pop() ?? cal.url;
			const ctag = (cal as unknown as { ctag?: string }).ctag;
			const color = (cal as unknown as { calendarColor?: string }).calendarColor;

			discovered.push({
				url: cal.url,
				displayName,
				ctag,
				color,
				supportsVTODO: true,
			});
		}

		Logger.debug(`Filtered to ${discovered.length} VTODO-supporting calendars`);
		return discovered;
	}

	/**
	 * Connect to CalDAV server and populate calendar map.
	 * Selects the default calendar by exact URL equality against settings.defaultCalendar.url.
	 * Fails fast if the default calendar URL doesn't match any discovered calendar.
	 */
	async connect(): Promise<void> {
		return withRetry(async () => {
			try {
				Logger.debug("Connecting to CalDAV server...");

				const password = this.app.secretStorage.getSecret(
					this.config.password,
				);
				if (!password) {
					throw new CalDAVAuthError(
						"Password not found in secure storage. Please configure your CalDAV password in settings.",
					);
				}

				const davClient = new DAVClient({
					serverUrl: this.config.serverUrl,
					credentials: {
						username: this.config.username,
						password,
					},
					authMethod: "Basic",
					defaultAccountType: "caldav",
				});

				await davClient.login();
				this.client = davClient as unknown as MinimalDAVClient;

				const rawCalendars = await this.client.fetchCalendars();
				Logger.debug(`Found ${rawCalendars?.length ?? 0} calendars on server`);

				this.calendars = new Map();
				for (const cal of rawCalendars ?? []) {
					this.calendars.set(cal.url, cal);
				}

				if (!this.config.defaultCalendar) {
					// No default configured — connect succeeds (login-only) but
					// calendar-level ops will fail until user picks one in settings.
					Logger.info("Connected to CalDAV server (no default calendar configured)");
					return;
				}

				// Resolve default calendar by exact URL equality (design D2)
				if (!this.calendars.has(this.config.defaultCalendar.url)) {
					throw new CalDAVError(
						`Default calendar not found on server: ${this.config.defaultCalendar.url}. ` +
							'Please run "Discover calendars" in settings to refresh.',
					);
				}

				const displayName =
					typeof this.config.defaultCalendar.displayName === "string"
						? this.config.defaultCalendar.displayName
						: this.config.defaultCalendar.url;
				Logger.info(`Connected to CalDAV calendar: ${displayName}`);
			} catch (error) {
				throw this.handleConnectionError(error);
			}
		});
	}

	/**
	 * Returns the in-memory calendar discovery cache (URL → DAVCalendar).
	 * Used by the sync engine to build the per-cycle fetch set.
	 */
	getDiscoveryCache(): Map<string, DAVCalendar> {
		return this.calendars;
	}

	/**
	 * Handle connection errors and convert to appropriate CalDAV error types
	 * Implements T072: Comprehensive error handling
	 */
	private handleConnectionError(error: unknown): Error {
		if (error instanceof CalDAVError) {
			return error; // Already a CalDAV error, pass through
		}

		if (error instanceof Error) {
			const message = error.message;

			// Check for authentication errors (including discovery-specific PROPFIND 401/403)
			if (
				message.includes("401") ||
				message.includes("403") ||
				message.includes("Unauthorized") ||
				message.includes("Forbidden")
			) {
				return new CalDAVAuthError(
					"Authentication failed. Please check your credentials.",
				);
			}

			// Check for network errors - connection refused
			if (
				message.includes("ERR_CONNECTION_REFUSED") ||
				message.includes("ECONNREFUSED")
			) {
				return new CalDAVNetworkError(
					`Cannot connect to server at ${this.config.serverUrl}. ` +
						"Please ensure the CalDAV server is running and accessible.",
				);
			}

			// Check for timeout errors
			if (message.includes("ETIMEDOUT") || message.includes("timeout")) {
				return new CalDAVTimeoutError(
					"Connection timed out. Please check your server URL and internet connection.",
				);
			}

			// Check for other network errors
			if (message.includes("ENOTFOUND") || message.includes("Network")) {
				return new CalDAVNetworkError(
					"Network error. Please check your server URL and internet connection.",
				);
			}

			// Check for server errors
			if (message.includes("500") || message.includes("503")) {
				const statusMatch = message.match(/(\d{3})/);
				const statusCode =
					statusMatch && statusMatch[1]
						? parseInt(statusMatch[1])
						: 500;
				return new CalDAVServerError(
					`Server error: ${message}`,
					statusCode,
				);
			}

			// Generic CalDAV error
			return new CalDAVError(`Connection failed: ${message}`);
		}

		// Unknown error type
		return new CalDAVError(`Unknown connection error: ${String(error)}`);
	}

	/**
	 * Disconnect from CalDAV server
	 */
	async disconnect(): Promise<void> {
		this.client = null;
		this.calendars = new Map();
	}

	/**
	 * Test connection to CalDAV server
	 * @returns true if connection successful
	 */
	async testConnection(): Promise<boolean> {
		try {
			await this.connect();
			await this.disconnect();
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Fetch all tasks from a specific calendar
	 * @param calendarUrl The exact URL of the calendar to fetch from
	 * @returns Array of CalDAV tasks
	 */
	async fetchAllTasks(calendarUrl: string): Promise<CalDAVTask[]> {
		if (!this.client) {
			throw new CalDAVError(
				"Client not connected. Call connect() first.",
			);
		}

		const calendar = this.getCalendar(calendarUrl);

		return withRetry(async () => {
			try {
				Logger.debug(`Fetching tasks from calendar: ${calendarUrl}`);

				// Age filtering of completed tasks is done client-side.
				const vtodoFilter: CalDAVFilter = {
					"comp-filter": {
						_attributes: { name: "VCALENDAR" },
						"comp-filter": {
							_attributes: { name: "VTODO" },
						},
					},
				};

				const calendarObjects = await this.client!.fetchCalendarObjects({
					calendar,
					filters: vtodoFilter,
				});

				Logger.debug(
					`Fetched ${calendarObjects?.length ?? 0} calendar objects from ${calendarUrl}`,
				);

				if (!calendarObjects || calendarObjects.length === 0) {
					return [];
				}

				const todoObjects = calendarObjects.filter((obj) => {
					const hasVTODO = obj.data && obj.data.includes("BEGIN:VTODO");
					if (!hasVTODO) {
						Logger.warn(
							`Object fetched with VTODO filter doesn't contain VTODO: ${obj.url}`,
						);
					}
					return hasVTODO;
				});

				Logger.debug(`Found ${todoObjects.length} VTODO objects in ${calendarUrl}`);

				return todoObjects.map((obj) => this.parseVTODOToTask(obj));
			} catch (error) {
				throw this.handleNetworkError(error, "fetch tasks");
			}
		});
	}

	/**
	 * Handle network errors and convert to appropriate CalDAV error types
	 * Implements T072: Comprehensive error handling
	 */
	private handleNetworkError(error: unknown, operation: string): Error {
		if (error instanceof CalDAVError) {
			return error; // Already a CalDAV error
		}

		if (error instanceof Error) {
			const message = error.message;

			// Check for timeout
			if (message.includes("timeout") || message.includes("ETIMEDOUT")) {
				return new CalDAVTimeoutError(
					`Timeout while trying to ${operation}`,
				);
			}

			// Check for network errors
			if (
				message.includes("Network") ||
				message.includes("ECONNREFUSED") ||
				message.includes("ENOTFOUND")
			) {
				return new CalDAVNetworkError(
					`Network error while trying to ${operation}: ${message}`,
				);
			}

			// Check for server errors
			if (message.includes("500") || message.includes("503")) {
				const statusMatch = message.match(/(\d{3})/);
				const statusCode =
					statusMatch && statusMatch[1]
						? parseInt(statusMatch[1])
						: 500;
				return new CalDAVServerError(
					`Server error while trying to ${operation}: ${message}`,
					statusCode,
				);
			}

			// Check for auth errors (including discovery-specific PROPFIND 401/403)
			if (
				message.includes("401") ||
				message.includes("403") ||
				message.includes("Unauthorized") ||
				message.includes("Forbidden")
			) {
				return new CalDAVAuthError(
					`Authentication failed while trying to ${operation}`,
				);
			}

			// Generic error
			return new CalDAVError(`Failed to ${operation}: ${message}`);
		}

		return new CalDAVError(
			`Unknown error while trying to ${operation}: ${String(error)}`,
		);
	}

	/**
	 * Create a task on CalDAV server
	 *
	 * Feature: Obsidian Link Sync (003-obsidian-link-sync)
	 * This method now accepts an optional description parameter that will be included
	 * in the VTODO DESCRIPTION field. The description contains an Obsidian URI that
	 * allows users to click a link in their CalDAV client and jump directly to the
	 * task location in Obsidian.
	 *
	 * The DESCRIPTION field is RFC 5545 compliant and supported by all major CalDAV
	 * servers. Text is properly escaped per iCalendar TEXT value specification.
	 *
	 * @param summary Task summary text (goes in SUMMARY field)
	 * @param due Due date (optional)
	 * @param status Task status (NEEDS-ACTION or COMPLETED)
	 * @param description Optional description text with Obsidian URI (goes in DESCRIPTION field)
	 * @returns Created CalDAV task with UID and etag
	 */
	async createTask(
		calendarUrl: string,
		summary: string,
		due: Date | null,
		status: VTODOStatus,
		description?: string,
	): Promise<CalDAVTask> {
		if (!this.client) {
			throw new CalDAVError(
				"Client not connected. Call connect() first.",
			);
		}
		const calendar = this.getCalendar(calendarUrl);

		const uid = crypto.randomUUID();
		const timestamp =
			new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

		// T035: Escape summary text per iCalendar spec
		const escapedSummary = escapeICalText(summary);

		let vtodoString = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Obsidian Tasks CalDAV Plugin//EN
BEGIN:VTODO
UID:${uid}
DTSTAMP:${timestamp}
SUMMARY:${escapedSummary}`;

		// Add DESCRIPTION field if provided (T022-T023)
		if (description) {
			const escapedDesc = escapeICalText(description);
			vtodoString += `\nDESCRIPTION:${escapedDesc}`;
		}

		vtodoString += `\nSTATUS:${status}
LAST-MODIFIED:${timestamp}`;

		if (due) {
			const dueString = this.formatDateForCalDAV(due);
			vtodoString += `\nDUE;VALUE=DATE:${dueString}`;
		}

		vtodoString += `
END:VTODO
END:VCALENDAR`;

		try {
			const result = await this.client.createCalendarObject({
				calendar,
				filename: `${uid}.ics`,
				iCalString: vtodoString,
			});

			return {
				uid,
				summary,
				due,
				status,
				lastModified: new Date(),
				etag: result.etag ?? "",
				href: result.url,
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new CalDAVError(
					`Failed to create task: ${error.message}`,
				);
			}
			throw error;
		}
	}

	/**
	 * Update a task on CalDAV server
	 * @param caldavUid The CalDAV UID
	 * @param summary Task summary
	 * @param due Due date
	 * @param status Task status
	 * @param etag Current ETag for optimistic locking
	 * @returns Updated CalDAV task
	 */
	async updateTask(
		caldavUid: string,
		summary: string,
		due: Date | null,
		status: VTODOStatus,
		etag: string,
		href: string,
	): Promise<CalDAVTask> {
		if (!this.client) {
			throw new CalDAVError(
				"Client not connected. Call connect() first.",
			);
		}

		const timestamp =
			new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

		let vtodoString = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Obsidian Tasks CalDAV Plugin//EN
BEGIN:VTODO
UID:${caldavUid}
DTSTAMP:${timestamp}
SUMMARY:${summary}
STATUS:${status}
LAST-MODIFIED:${timestamp}`;

		if (due) {
			const dueString = this.formatDateForCalDAV(due);
			vtodoString += `\nDUE;VALUE=DATE:${dueString}`;
		}

		vtodoString += `
END:VTODO
END:VCALENDAR`;

		// DEBUG
		Logger.debug("=== CalDAV Update Debug ===");
		Logger.debug(`Updating task: ${caldavUid}`);
		Logger.debug(`Summary: ${summary}`);
		Logger.debug(`Status: ${status}`);
		Logger.debug(`Due: ${due?.toISOString() ?? "none"}`);
		Logger.debug(`ETag: ${etag}`);
		Logger.debug(`URL: ${href}`);
		Logger.debug("VTODO data:", vtodoString);
		Logger.debug("===========================");

		try {
			const result = await this.client.updateCalendarObject({
				calendarObject: {
					url: href,
					data: vtodoString,
					etag,
				},
			});

			// DEBUG
			Logger.debug("Update result:", result);

			let newEtag = result.etag;

			// If the server didn't return a new etag (common CalDAV behavior),
			// we need to fetch the task to get the fresh etag
			if (!newEtag) {
				Logger.debug(
					"Server did not return etag in update response, fetching fresh etag...",
				);
				const freshTask = await this.fetchTaskByUid(caldavUid);
				if (freshTask) {
					newEtag = freshTask.etag;
					Logger.debug(`Fetched fresh etag: ${newEtag}`);
				} else {
					Logger.warn(
						`Could not fetch fresh etag for task ${caldavUid}, using old etag`,
					);
					newEtag = etag;
				}
			}

			return {
				uid: caldavUid,
				summary,
				due,
				status,
				lastModified: new Date(),
				etag: newEtag,
				href,
			};
		} catch (error) {
			Logger.error("CalDAV update error", error);

			if (error instanceof Error) {
				// T049: Handle 412 Precondition Failed (ETag conflict)
				if (
					error.message.includes("412") ||
					error.message.includes("Precondition Failed")
				) {
					throw new CalDAVConflictError(
						`Task was modified on server. Please sync again to get latest version.`,
						etag,
					);
				}

				// Handle connection errors during update
				if (
					error.message.includes("ERR_CONNECTION_REFUSED") ||
					error.message.includes("ECONNREFUSED")
				) {
					throw new CalDAVNetworkError(
						`Cannot reach CalDAV server to update task. Server may be offline.`,
					);
				}

				throw new CalDAVError(
					`Failed to update task: ${error.message}`,
				);
			}
			throw error;
		}
	}

	/**
	 * Update a task while preserving extended CalDAV properties
	 * T028 (002-sync-polish): Read-before-update pattern for property preservation
	 * @param caldavUid The CalDAV UID
	 * @param summary New task description
	 * @param due New due date (or null)
	 * @param status New status
	 * @param etag Current ETag for optimistic locking
	 * @param href Resource URL
	 * @returns Updated CalDAV task
	 */
	async updateTaskWithPreservation(
		caldavUid: string,
		summary: string,
		due: Date | null,
		status: VTODOStatus,
		etag: string,
		href: string,
		calendarUrl?: string,
	): Promise<CalDAVTask> {
		if (!this.client) {
			throw new CalDAVError(
				"Client not connected. Call connect() first.",
			);
		}

		try {
			// T027: Fetch the existing raw VTODO data
			const existingVTODO = await this.fetchTaskRawData(caldavUid, calendarUrl);

			if (!existingVTODO) {
				throw new CalDAVError(
					`Task with UID ${caldavUid} not found on server. It may have been deleted.`,
				);
			}

			Logger.debug(
				`Updating task ${caldavUid} with property preservation`,
			);

			// T026: Update only managed properties, preserving everything else
			const updatedVTODO = updateVTODOProperties(
				existingVTODO,
				summary,
				due,
				status,
			);

			// Send the modified VTODO back to the server
			const result = await this.client.updateCalendarObject({
				calendarObject: {
					url: href,
					data: updatedVTODO,
					etag,
				},
			});

			let newEtag = result.etag;

			// If the server didn't return a new etag, fetch it
			if (!newEtag) {
				Logger.debug(
					"Server did not return etag in update response, fetching fresh etag...",
				);
				const freshTask = await this.fetchTaskByUid(caldavUid);
				if (freshTask) {
					newEtag = freshTask.etag;
					Logger.debug(`Fetched fresh etag: ${newEtag}`);
				} else {
					Logger.warn(
						`Could not fetch fresh etag for task ${caldavUid}, using old etag`,
					);
					newEtag = etag;
				}
			}

			Logger.debug(
				`Task ${caldavUid} updated successfully with preserved properties`,
			);

			return {
				uid: caldavUid,
				summary,
				due,
				status,
				lastModified: new Date(),
				etag: newEtag,
				href,
			};
		} catch (error) {
			if (error instanceof Error) {
				// Handle 412 Precondition Failed (ETag conflict)
				if (
					error.message.includes("412") ||
					error.message.includes("Precondition Failed")
				) {
					throw new CalDAVConflictError(
						`Task was modified on server. Please sync again to get latest version.`,
						etag,
					);
				}

				// Handle connection errors
				if (
					error.message.includes("ERR_CONNECTION_REFUSED") ||
					error.message.includes("ECONNREFUSED")
				) {
					throw new CalDAVNetworkError(
						`Cannot reach CalDAV server to update task. Server may be offline.`,
					);
				}

				throw new CalDAVError(
					`Failed to update task with preservation: ${error.message}`,
				);
			}
			throw error;
		}
	}

	/**
	 * Delete a task from CalDAV server
	 * @param caldavUid The CalDAV UID
	 * @param etag Current ETag
	 * @param href Resource URL
	 */
	async deleteTask(
		caldavUid: string,
		etag: string,
		href: string,
	): Promise<void> {
		if (!this.client) {
			throw new CalDAVError(
				"Client not connected. Call connect() first.",
			);
		}

		try {
			await this.client.deleteCalendarObject({
				calendarObject: {
					url: href,
					etag,
				},
			});
		} catch (error) {
			if (error instanceof Error) {
				throw new CalDAVError(
					`Failed to delete task: ${error.message}`,
				);
			}
			throw error;
		}
	}

	/**
	 * Fetch a single task by UID to get fresh metadata (especially etag).
	 * If calendarUrl is provided, searches only that calendar; otherwise searches all discovered calendars.
	 * @param uid The CalDAV UID of the task
	 * @param calendarUrl Optional calendar URL to restrict the search
	 * @returns The task with fresh metadata, or null if not found
	 */
	async fetchTaskByUid(uid: string, calendarUrl?: string): Promise<CalDAVTask | null> {
		if (!this.client) {
			throw new CalDAVError(
				"Client not connected. Call connect() first.",
			);
		}

		const searchCalendars = calendarUrl
			? [this.getCalendar(calendarUrl)]
			: Array.from(this.calendars.values());

		const vtodoFilter = {
			"comp-filter": {
				_attributes: { name: "VCALENDAR" },
				"comp-filter": { _attributes: { name: "VTODO" } },
			},
		};

		try {
			for (const cal of searchCalendars) {
				const calendarObjects = await this.client.fetchCalendarObjects({
					calendar: cal,
					filters: vtodoFilter,
				});
				if (!calendarObjects) continue;
				for (const obj of calendarObjects) {
					if (obj.data && obj.data.includes(`UID:${uid}`)) {
						return this.parseVTODOToTask(obj);
					}
				}
			}
			return null;
		} catch (error) {
			Logger.warn(
				`Failed to fetch task by UID ${uid}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return null;
		}
	}

	/**
	 * Fetch the raw iCalendar VTODO data for a task.
	 * If calendarUrl is provided, searches only that calendar; otherwise searches all discovered calendars.
	 * @param uid The CalDAV UID of the task
	 * @param calendarUrl Optional calendar URL to restrict the search
	 * @returns The raw VTODO iCalendar string, or null if not found
	 */
	async fetchTaskRawData(uid: string, calendarUrl?: string): Promise<string | null> {
		if (!this.client) {
			throw new CalDAVError(
				"Client not connected. Call connect() first.",
			);
		}

		const searchCalendars = calendarUrl
			? [this.getCalendar(calendarUrl)]
			: Array.from(this.calendars.values());

		const vtodoFilter = {
			"comp-filter": {
				_attributes: { name: "VCALENDAR" },
				"comp-filter": { _attributes: { name: "VTODO" } },
			},
		};

		try {
			for (const cal of searchCalendars) {
				const calendarObjects = await this.client.fetchCalendarObjects({
					calendar: cal,
					filters: vtodoFilter,
				});
				if (!calendarObjects) continue;
				for (const obj of calendarObjects) {
					if (obj.data && obj.data.includes(`UID:${uid}`)) {
						Logger.debug(`Fetched raw VTODO data for UID ${uid} from ${cal.url}`);
						return obj.data;
					}
				}
			}
			Logger.debug(`Task with UID ${uid} not found on server`);
			return null;
		} catch (error) {
			Logger.warn(
				`Failed to fetch raw VTODO data for UID ${uid}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return null;
		}
	}

	/**
	 * Copy a VTODO to a different calendar (step 1 of move, per design D7).
	 * Creates the VTODO at the destination with the same UID, returns the new task metadata.
	 * @param sourceHref Full URL of the source VTODO
	 * @param sourceEtag ETag of the source VTODO
	 * @param destinationCalendarUrl URL of the destination calendar
	 */
	async copyTaskToCalendar(
		sourceHref: string,
		sourceEtag: string,
		destinationCalendarUrl: string,
	): Promise<CalDAVTask> {
		if (!this.client) {
			throw new CalDAVError("Client not connected. Call connect() first.");
		}

		const destCalendar = this.getCalendar(destinationCalendarUrl);

		// Fetch raw data from source
		const uid = sourceHref.split("/").pop()?.replace(".ics", "") ?? "";
		const rawData = await this.fetchTaskRawData(uid);
		if (!rawData) {
			throw new CalDAVError(`Cannot copy task: source VTODO not found at ${sourceHref}`);
		}

		// Extract UID from raw data
		const uidMatch = rawData.match(/UID:([^\r\n]+)/);
		const taskUid = uidMatch?.[1] ?? uid;
		const filename = `${taskUid}.ics`;

		try {
			const result = await this.client.createCalendarObject({
				calendar: destCalendar,
				filename,
				iCalString: rawData,
			});

			return this.parseVTODOToTask({
				url: result.url,
				data: rawData,
				etag: result.etag ?? sourceEtag,
			});
		} catch (error) {
			if (error instanceof Error) {
				throw new CalDAVError(`Failed to copy task to ${destinationCalendarUrl}: ${error.message}`);
			}
			throw error;
		}
	}

	/**
	 * Parse a VTODO calendar object to CalDAVTask format
	 */
	private parseVTODOToTask(obj: {
		url: string;
		data: string;
		etag?: string;
	}): CalDAVTask {
		const data = obj.data;
		// Extract UID
		const uidMatch = data.match(/UID:([^\r\n]+)/);
		const uid = uidMatch?.[1] ?? "";

		// Extract SUMMARY
		const summaryMatch = data.match(/SUMMARY:([^\r\n]+)/);
		const summary = summaryMatch?.[1] ?? "";

		// Extract DUE date - handles multiple iCalendar formats:
		// - DUE:YYYYMMDD (date only)
		// - DUE;VALUE=DATE:YYYYMMDD (explicit date)
		// - DUE:YYYYMMDDTHHMMSSZ (UTC datetime)
		// - DUE:YYYYMMDDTHHMMSS (floating datetime)
		// - DUE;TZID=...:YYYYMMDDTHHMMSS (datetime with timezone)
		const dueMatch = data.match(/^DUE(?:;[^:]+)?:(\d{8})(?:T(\d{6}))?Z?/m);
		let due: Date | null = null;
		if (dueMatch && dueMatch[1]) {
			const dateStr = dueMatch[1];
			const timeStr = dueMatch[2]; // may be undefined for date-only
			due = this.parseDateTimeFromCalDAV(dateStr, timeStr);
		}

		// Extract STATUS
		const statusMatch = data.match(/STATUS:([^\r\n]+)/);
		const statusStr = statusMatch?.[1] ?? "NEEDS-ACTION";
		const status =
			statusStr === "COMPLETED"
				? VTODOStatus.Completed
				: VTODOStatus.NeedsAction;

		// Extract LAST-MODIFIED (optional per RFC 5545; fall back to epoch so
		// that a missing value doesn't masquerade as "just now")
		const lastModMatch = data.match(/LAST-MODIFIED:([^\r\n]+)/);
		const lastModified =
			lastModMatch && lastModMatch[1]
				? new Date(this.parseISODateTime(lastModMatch[1]))
				: new Date(0);

		return {
			uid,
			summary,
			due,
			status,
			lastModified,
			etag: obj.etag ?? "",
			href: obj.url,
		};
	}

	/**
	 * Format Date for CalDAV (YYYYMMDD)
	 */
	private formatDateForCalDAV(date: Date): string {
		const year = date.getUTCFullYear();
		const month = String(date.getUTCMonth() + 1).padStart(2, "0");
		const day = String(date.getUTCDate()).padStart(2, "0");
		return `${year}${month}${day}`;
	}

	/**
	 * Parse CalDAV date string (YYYYMMDD) to Date
	 */
	private parseDateFromCalDAV(dateStr: string): Date {
		const year = dateStr.substring(0, 4);
		const month = dateStr.substring(4, 6);
		const day = dateStr.substring(6, 8);
		return new Date(`${year}-${month}-${day}T00:00:00Z`);
	}

	/**
	 * Parse CalDAV date/datetime to Date
	 * @param dateStr Date portion (YYYYMMDD)
	 * @param timeStr Optional time portion (HHMMSS)
	 * @returns Date object
	 */
	private parseDateTimeFromCalDAV(dateStr: string, timeStr?: string): Date {
		const year = dateStr.substring(0, 4);
		const month = dateStr.substring(4, 6);
		const day = dateStr.substring(6, 8);

		if (timeStr) {
			const hour = timeStr.substring(0, 2);
			const minute = timeStr.substring(2, 4);
			const second = timeStr.substring(4, 6);
			// Treat all times as UTC. This is correct for the common Z-suffixed
			// format (DUE:YYYYMMDDTHHMMSSZ). For TZID-parameterised times the
			// date portion is still correct; full VTIMEZONE conversion is out of
			// scope for date-only sync.
			return new Date(
				`${year}-${month}-${day}T${hour}:${minute}:${second}Z`,
			);
		}

		// Date-only: return midnight UTC
		return new Date(`${year}-${month}-${day}T00:00:00Z`);
	}

	/**
	 * Parse ISO datetime string (YYYYMMDDTHHMMSSZ) to ISO 8601
	 */
	private parseISODateTime(isoStr: string): string {
		// Convert YYYYMMDDTHHMMSSZ to YYYY-MM-DDTHH:MM:SSZ
		const match = isoStr.match(
			/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/,
		);
		if (!match) {
			return new Date(0).toISOString();
		}
		const [, year, month, day, hour, minute, second] = match;
		return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
	}
}
