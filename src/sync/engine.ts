/**
 * Sync engine for bidirectional task synchronization
 * Based on tasks.md T040-T045 specifications
 * Refactored for Phase 9: Polish & Cross-Cutting Concerns
 */

import { Vault, Notice, App } from "obsidian";
import { Task, CalDAVConfiguration, SyncMapping, CalDAVTask, HyperlinkSyncMode } from "../types";
import { CalDAVClient } from "../caldav/client";
import { SyncFilter } from "./filters";
import { scanVaultForTasks } from "../vault/scanner";
import { updateTaskLine } from "../vault/taskWriter";
import { generateTaskBlockId, embedBlockId } from "../vault/blockRefManager";
import { taskToVTODO } from "../caldav/vtodo";
import { hashTaskContent, getMappingByBlockId, setMapping, getAllMappings, removeMapping } from "./mapping";
import {
	showSyncStart,
	showSyncSuccess,
	showSyncError,
} from "../ui/notifications";
import { vtodoToTask } from "../caldav/vtodo";
import { updateTaskInVault } from "../vault/taskWriter";
import {
	resolveConflict,
	formatConflictLog,
	hasConflict,
} from "./conflictResolver";
import { Logger } from "./logger";
import { buildObsidianURI, buildDescriptionWithURI } from "../obsidian/uriBuilder";
import { processDescription } from "./hyperlinkProcessor";

/**
 * Sync statistics for tracking sync progress
 */
interface SyncStats {
	successCount: number;
	errorCount: number;
	errors: string[];
	skippedCalendars: string[];
}

/** A single observation of a VTODO in a specific calendar during a sync cycle */
interface ObservedTask {
	calendarUrl: string;
	href: string;
	lastModified: Date;
	task: CalDAVTask;
}

/**
 * Sync engine class for orchestrating task synchronization
 */
export class SyncEngine {
	private app: App;
	private vault: Vault;
	private config: CalDAVConfiguration;
	private client: CalDAVClient;
	private filter: SyncFilter;
	private saveData: () => Promise<void>;
	/**
	 * Performance optimization: Track if mappings have been modified
	 * Enables batched persistence instead of saving after every task operation
	 */
	private dirtyMappings = false;

	constructor(
		app: App,
		vault: Vault,
		config: CalDAVConfiguration,
		saveData: () => Promise<void>
	) {
		this.app = app;
		this.vault = vault;
		this.config = config;
		this.client = new CalDAVClient(app, config);
		this.filter = new SyncFilter(config);
		this.saveData = saveData;
	}

	/**
	 * Update filter with new configuration (T069)
	 * Called when settings change
	 */
	updateFilter(): void {
		this.filter = new SyncFilter(this.config);
	}

	/**
	 * Perform bidirectional sync between Obsidian and CalDAV
	 * This implements T040: Initial sync logic and T058: Bidirectional sync integration
	 * Refactored for better readability and maintainability
	 * @param isAutoSync Whether this is an automatic sync (T009, 002-sync-polish)
	 */
	async syncObsidianToCalDAV(isAutoSync: boolean = false): Promise<void> {
		if (!isAutoSync) {
			showSyncStart();
		}
		// T019: Log sync start at INFO level (always shown)
		Logger.syncStart();

		const stats: SyncStats = {
			successCount: 0,
			errorCount: 0,
			errors: [],
			skippedCalendars: [],
		};

		try {
			// Connect to CalDAV server
			await this.connectToServer();

			// Fetch tasks from both sources
			const { caldavTasks, obsidianTasks } = await this.fetchAllTasks(isAutoSync, stats);

			// Process each Obsidian task
			await this.processObsidianTasks(obsidianTasks, caldavTasks, stats);

			// Disconnect from CalDAV
			await this.client.disconnect();

			// Performance optimization: Batched persistence
			// Save mappings once at the end instead of after every task operation
			if (this.dirtyMappings) {
				Logger.debug("Persisting mapping changes to disk");
				await this.saveData();
				this.dirtyMappings = false;
			}

			// Show sync results
			this.showSyncResults(stats, isAutoSync);

			// T020: Log sync completion at INFO level (always shown)
			Logger.syncComplete();
		} catch (error) {
			// On error, still save partial progress to preserve mappings created so far
			if (this.dirtyMappings) {
				Logger.debug("Sync failed, persisting partial progress");
				try {
					await this.saveData();
					this.dirtyMappings = false;
				} catch (saveError) {
					Logger.error("Failed to save partial progress", saveError);
				}
			}
			this.handleSyncError(error);
			throw error;
		}
	}

	/**
	 * Connect to CalDAV server with error handling
	 * Implements T072: Comprehensive error handling for network failures
	 */
	private async connectToServer(): Promise<void> {
		try {
			await this.client.connect();
			Logger.debug("Connected to CalDAV server");
		} catch (error) {
			const errorMsg =
				error instanceof Error ? error.message : String(error);

			if (
				errorMsg.includes("ERR_CONNECTION_REFUSED") ||
				errorMsg.includes("ECONNREFUSED")
			) {
				throw new Error(
					"Cannot connect to CalDAV server. Please check:\n" +
						"1. The server URL is correct\n" +
						"2. The CalDAV server is running\n" +
						"3. You have network connectivity"
				);
			}

			throw error;
		}
	}

	/**
	 * Fetch tasks from both Obsidian vault and CalDAV server.
	 * Fetches from every calendar in the discovery cache (design D4).
	 * Runs remote-move detection before returning (design D5).
	 */
	private async fetchAllTasks(isAutoSync: boolean = false, stats: SyncStats): Promise<{
		caldavTasks: Map<string, CalDAVTask>;
		obsidianTasks: Task[];
	}> {
		const discoveryCache = this.client.getDiscoveryCache();
		const calendarUrls = Array.from(discoveryCache.keys());

		// If no calendars discovered yet, fall back to defaultCalendar if set
		const fetchUrls = calendarUrls.length > 0
			? calendarUrls
			: (this.config.defaultCalendar ? [this.config.defaultCalendar.url] : []);

		if (fetchUrls.length === 0) {
			Logger.warn("No calendars available to fetch from");
			return { caldavTasks: new Map(), obsidianTasks: [] };
		}

		// Fan-out fetches with bounded concurrency of 4 (design D4)
		const CONCURRENCY = 4;
		// uid → observations across all calendars
		const uidObservations = new Map<string, ObservedTask[]>();
		// UIDs seen on the server but excluded by the sync filter (e.g. old completed tasks)
		const filteredOutUids = new Set<string>();

		for (let i = 0; i < fetchUrls.length; i += CONCURRENCY) {
			const batch = fetchUrls.slice(i, i + CONCURRENCY);
			const results = await Promise.allSettled(
				batch.map(async (url) => {
					const tasks = await this.client.fetchAllTasks(url);
					return { url, tasks };
				}),
			);

			for (const result of results) {
				if (result.status === "rejected") {
					const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
					Logger.warn(`Failed to fetch from calendar (skipping): ${reason}`);
					// Try to extract URL for stats — best-effort
					continue;
				}
				const { url, tasks } = result.value;
				for (const task of tasks) {
					if (!this.filter.shouldSyncCalDAVTask(task)) {
						filteredOutUids.add(task.uid);
						continue;
					}
					const obs: ObservedTask = {
						calendarUrl: url,
						href: task.href,
						lastModified: task.lastModified,
						task,
					};
					const existing = uidObservations.get(task.uid) ?? [];
					existing.push(obs);
					uidObservations.set(task.uid, existing);
				}
			}
		}

		// Detect and resolve calendars that were previously seen but are now missing (task 3.3)
		const allMappings = getAllMappings();
		const missedUrls = new Set<string>();
		for (const mapping of allMappings.values()) {
			if (mapping.calendarUrl && !discoveryCache.has(mapping.calendarUrl) && discoveryCache.size > 0) {
				missedUrls.add(mapping.calendarUrl);
			}
		}
		for (const url of missedUrls) {
			Logger.warn(`Calendar no longer in discovery cache: ${url}`);
			stats.skippedCalendars.push(url);
		}

		// Remote-move detection (design D5, tasks 3.7–3.10)
		this.detectRemoteMoves(uidObservations, allMappings);

		// Flatten observations to a UID-keyed map (one task per UID, already deduplicated by detectRemoteMoves)
		const caldavTasks = new Map<string, CalDAVTask>();
		for (const [uid, observations] of uidObservations) {
			// Pick the canonical observation (most recent last-modified wins if multiple)
			const canonical = observations.reduce((best, obs) =>
				obs.lastModified > best.lastModified ? obs : best,
			);
			caldavTasks.set(uid, canonical.task);
		}
		Logger.info(`Fetched ${caldavTasks.size} tasks from ${fetchUrls.length} calendar(s)`);

		// Scan vault for tasks
		const allTasks = await scanVaultForTasks(this.vault);

		// Apply filters
		const obsidianTasks = allTasks.filter((task) =>
			this.filter.shouldSync(task, this.config, allMappings)
		);

		if (!isAutoSync) {
			this.showFilterStats(allTasks.length, obsidianTasks.length);
		}

		// Handle UIDs not found in any calendar (task 3.10).
		// Cross-reference with vault: if the Obsidian task is no longer active (completed,
		// deleted, or filtered out of sync scope), silently drop the stale mapping instead
		// of surfacing a spurious notice to the user.
		const activeSyncBlockIds = new Set(obsidianTasks.map((t) => t.blockId));
		let missingUidNoticeShown = false;
		for (const [blockId, mapping] of allMappings.entries()) {
			if (!uidObservations.has(mapping.caldavUid)) {
				if (filteredOutUids.has(mapping.caldavUid) || !activeSyncBlockIds.has(blockId)) {
					Logger.debug(`UID ${mapping.caldavUid} not found on server but Obsidian task is inactive — removing stale mapping`);
					removeMapping(blockId);
					continue;
				}
				if (!missingUidNoticeShown) {
					new Notice(
						'Some synced tasks were not found in any discovered calendar. ' +
						'Try clicking "Discover calendars" in settings to refresh the calendar list.',
						8000,
					);
					missingUidNoticeShown = true;
				}
				Logger.warn(`UID ${mapping.caldavUid} not found in any discovered calendar — mapping preserved`);
			}
		}

		return { caldavTasks, obsidianTasks };
	}

	/**
	 * Remote-move detection (design D5).
	 * Updates mappings in-memory when a UID is observed in a different calendar than recorded.
	 * Handles duplicate UIDs by picking the most-recently-modified copy.
	 */
	private detectRemoteMoves(
		uidObservations: Map<string, ObservedTask[]>,
		allMappings: Map<string, SyncMapping>,
	): void {
		for (const mapping of allMappings.values()) {
			const observations = uidObservations.get(mapping.caldavUid);
			if (!observations || observations.length === 0) continue;

			let canonical: ObservedTask;
			if (observations.length === 1) {
				canonical = observations[0]!;
			} else {
				// Multiple observations of the same UID — pick the most recently modified
				canonical = observations.reduce((best, obs) =>
					obs.lastModified > best.lastModified ? obs : best,
				);
				const otherUrls = observations
					.filter((o) => o.calendarUrl !== canonical.calendarUrl)
					.map((o) => o.calendarUrl)
					.join(", ");
				Logger.warn(
					`UID ${mapping.caldavUid} found in multiple calendars: ${observations.map(o => o.calendarUrl).join(", ")}. ` +
					`Using most recently modified copy at ${canonical.calendarUrl}. Duplicates in [${otherUrls}] not auto-deleted.`,
				);
			}

			// Detect remote move: observed calendar differs from mapping
			if (canonical.calendarUrl !== mapping.calendarUrl) {
				Logger.info(
					`Remote move detected for UID ${mapping.caldavUid}: ` +
					`${mapping.calendarUrl} → ${canonical.calendarUrl}`,
				);
				mapping.calendarUrl = canonical.calendarUrl;
				mapping.caldavHref = canonical.href;
				setMapping(mapping);
			}
		}
	}

	/**
	 * Show filter statistics to user
	 */
	private showFilterStats(totalTasks: number, filteredTasks: number): void {
		const excludedCount = totalTasks - filteredTasks;

		if (excludedCount > 0) {
			new Notice(
				`Found ${filteredTasks} tasks to sync (${excludedCount} excluded by filters)`,
				5000
			);
			Logger.info(`${excludedCount} tasks excluded by filters`);
		} else {
			new Notice(`Found ${filteredTasks} tasks to sync`, 3000);
		}
	}

	/**
	 * Process all Obsidian tasks for sync
	 */
	private async processObsidianTasks(
		obsidianTasks: Task[],
		caldavTasks: Map<string, CalDAVTask>,
		stats: SyncStats
	): Promise<void> {
		for (const task of obsidianTasks) {
			try {
				await this.processTask(task, caldavTasks, stats);
			} catch (error) {
				this.handleTaskError(task, error, stats);
			}
		}
	}

	/**
	 * Process a single task for sync
	 */
	private async processTask(
		task: Task,
		caldavTasks: Map<string, CalDAVTask>,
		stats: SyncStats
	): Promise<void> {
		// Handle untracked tasks (no block ID)
		if (!task.blockId || task.blockId === "") {
			await this.handleUntrackedTask(task);
			stats.successCount++;
			return;
		}

		// Get or create mapping for this task
		const mapping = await this.getOrCreateMapping(task, caldavTasks);

		if (!mapping) {
			// No mapping and no matching CalDAV task - skip
			return;
		}

		// Refresh mapping metadata if needed
		await this.refreshMappingMetadata(mapping, caldavTasks);

		// Find corresponding CalDAV task (O(1) lookup with Map)
		const caldavTask = caldavTasks.get(mapping.caldavUid);

		if (!caldavTask) {
			Logger.warn(`CalDAV task not found for UID ${mapping.caldavUid} — skipping (task already has block ID ${task.blockId})`);
			return;
		}

		// Perform bidirectional sync
		await this.syncBidirectional(task, caldavTask, mapping);
		stats.successCount++;
	}

	/**
	 * Handle a task that doesn't have a block ID yet
	 */
	private async handleUntrackedTask(task: Task): Promise<void> {
		Logger.debug(`Creating new task: ${task.description}`);
		await this.addBlockIdToTask(task);
		await this.createTaskOnCalDAV(task);
	}

	/**
	 * Get existing mapping or create a new one by matching with CalDAV
	 */
	private async getOrCreateMapping(
		task: Task,
		caldavTasks: Map<string, CalDAVTask>
	): Promise<SyncMapping | null> {
		// Check for existing mapping
		let mapping = getMappingByBlockId(task.blockId);

		if (mapping) {
			return mapping;
		}

		Logger.debug(
			`No mapping found for task ${task.blockId}, attempting reconciliation`
		);

		// Try to find matching CalDAV task by description
		const caldavTask = await this.findCalDAVTaskByDescription(
			caldavTasks,
			task.description
		);

		if (caldavTask) {
			Logger.debug(
				`Found matching CalDAV task, reconciling: ${caldavTask.uid}`
			);
			mapping = await this.reconcileTask(task, caldavTask);
			return mapping;
		}

		// No mapping and no matching CalDAV task
		return null;
	}

	/**
	 * Refresh mapping metadata (href, etag) if missing
	 */
	private async refreshMappingMetadata(
		mapping: SyncMapping,
		caldavTasks: Map<string, CalDAVTask>
	): Promise<void> {
		// Check if metadata is missing
		if (mapping.caldavHref && mapping.caldavEtag) {
			return; // Already has metadata
		}

		Logger.debug(`Refreshing mapping metadata for task ${mapping.blockId}`);

		// Find the corresponding CalDAV task (O(1) lookup with Map)
		const caldavTask = caldavTasks.get(mapping.caldavUid);

		if (!caldavTask) {
			Logger.warn(
				`Cannot refresh metadata: CalDAV task not found for UID ${mapping.caldavUid}`
			);
			return;
		}

		// Update mapping with missing metadata
		// IMPORTANT: Only refresh href/etag, NOT lastKnownCalDAVModified
		mapping.caldavHref = caldavTask.href;
		mapping.caldavEtag = caldavTask.etag;

		setMapping(mapping);
		// Performance optimization: Mark dirty instead of saving immediately
		this.dirtyMappings = true;

		Logger.debug(`Metadata refreshed for task ${mapping.blockId}`);
	}

	/**
	 * Perform bidirectional sync between Obsidian and CalDAV
	 */
	private async syncBidirectional(
		task: Task,
		caldavTask: CalDAVTask,
		mapping: SyncMapping
	): Promise<void> {
		// Detect changes from both sides
		const obsidianChanged = this.detectObsidianChanges(task, mapping);
		const caldavChanged = this.detectCalDAVChanges(caldavTask, mapping);

		// Handle conflicts
		if (hasConflict(obsidianChanged, caldavChanged)) {
			await this.handleConflict(task, caldavTask, mapping);
			return;
		}

		// Handle Obsidian changes
		if (obsidianChanged) {
			Logger.debug(`Obsidian changes detected for: ${task.description}`);
			await this.updateCalDAVTask(task, mapping);
			return;
		}

		// Handle CalDAV changes
		if (caldavChanged) {
			Logger.debug(`CalDAV changes detected for: ${task.description}`);
			await this.updateObsidianTask(task, caldavTask, mapping);
			return;
		}

		// Check for data mismatch (edge case)
		// This handles cases where timestamp-based change detection fails
		// (e.g., clock skew, server not updating LAST-MODIFIED properly)
		if (this.needsReconciliation(task, caldavTask)) {
			Logger.warn(`Data mismatch detected for: ${task.description}`);
			Logger.warn(`  Obsidian: "${task.description}" (${task.status})`);
			Logger.warn(
				`  CalDAV: "${caldavTask.summary}" (${caldavTask.status})`
			);

			// Determine direction: if Obsidian hash unchanged, CalDAV must have changed
			const currentHash = hashTaskContent(task);
			const obsidianUnchanged =
				currentHash === mapping.lastKnownContentHash;

			if (obsidianUnchanged) {
				// Obsidian data unchanged since last sync, so CalDAV must have changed
				// Pull changes from CalDAV to Obsidian
				Logger.warn(`  Obsidian unchanged, pulling from CalDAV...`);
				await this.updateObsidianTask(task, caldavTask, mapping);
			} else {
				// Obsidian changed, push to CalDAV
				Logger.warn(`  Obsidian changed, pushing to CalDAV...`);
				await this.updateCalDAVTask(task, mapping);
			}
		}
	}

	/**
	 * Handle conflicts when both sides have changed
	 */
	private async handleConflict(
		task: Task,
		caldavTask: CalDAVTask,
		mapping: SyncMapping
	): Promise<void> {
		Logger.info(`Conflict detected for task: ${task.description}`);

		// Resolve conflict using last-write-wins
		const resolution = resolveConflict(task, caldavTask, mapping);

		// Log the conflict resolution
		const logMessage = formatConflictLog(resolution, task.description);
		Logger.info(logMessage);

		// Apply the winning side
		if (resolution.winner === "caldav") {
			await this.updateObsidianTask(task, caldavTask, mapping);
		} else {
			await this.updateCalDAVTask(task, mapping);
		}
	}

	/**
	 * Handle task processing error
	 * Implements T044: Error handling for failed task uploads
	 */
	private handleTaskError(
		task: Task,
		error: unknown,
		stats: SyncStats
	): void {
		stats.errorCount++;
		const errorMsg = error instanceof Error ? error.message : String(error);
		const errorLocation = `${task.filePath}:${task.lineNumber}`;
		stats.errors.push(`${errorLocation} - ${errorMsg}`);

		Logger.error(`Failed to sync task at ${errorLocation}`, error);
	}

	/**
	 * Handle sync-level error
	 * Implements T044: Error handling
	 */
	private handleSyncError(error: unknown): void {
		const errorMsg = error instanceof Error ? error.message : String(error);
		Logger.error(`Sync failed: ${errorMsg}`, error);
		showSyncError(`Sync failed: ${errorMsg}`, []);
	}

	/**
	 * Show sync results to user
	 * Implements T045: Sync progress feedback
	 * @param isAutoSync Whether this is an automatic sync (T012, 002-sync-polish)
	 */
	private showSyncResults(stats: SyncStats, isAutoSync: boolean = false): void {
		// Surface skipped-calendar summary when relevant
		if (stats.skippedCalendars.length > 0) {
			new Notice(
				`Sync: ${stats.skippedCalendars.length} calendar(s) could not be reached and were skipped. ` +
				`Click "Discover calendars" in settings to refresh.`,
				8000,
			);
		}

		if (stats.errorCount === 0) {
			Logger.info(`Successfully synced ${stats.successCount} tasks`);
			if (!isAutoSync) {
				showSyncSuccess(`Successfully synced ${stats.successCount} tasks`);
			}
		} else {
			Logger.warn(
				`Sync completed with errors: ${stats.successCount} succeeded, ${stats.errorCount} failed`
			);
			showSyncError(
				`Sync completed with errors: ${stats.successCount} succeeded, ${stats.errorCount} failed`,
				stats.errors
			);
		}
	}

	/**
	 * Add block ID to a task that doesn't have one
	 * Implements T042: Block ID generation for untracked tasks
	 */
	private async addBlockIdToTask(task: Task): Promise<void> {
		// Generate new block ID
		const blockId = generateTaskBlockId();

		// Update task object
		task.blockId = blockId;

		// Embed block ID in the task line
		const newLine = embedBlockId(task.rawLine, blockId);

		// Update the file
		await updateTaskLine(this.vault, task, newLine);

		// Update rawLine in task object
		task.rawLine = newLine;
	}

	/**
	 * Create a task on CalDAV server and store mapping
	 *
	 * Implements T038: CalDAV task creation and T043: Store sync mappings
	 * Feature: Obsidian Link Sync (003-obsidian-link-sync)
	 *
	 * This method now generates an Obsidian deep link URI and includes it in the
	 * CalDAV DESCRIPTION field during initial task creation. The URI enables users
	 * to click a link in their CalDAV client (e.g., Apple Calendar, Google Calendar)
	 * and jump directly to the task location in Obsidian.
	 *
	 * URI Format: obsidian://open?vault={encoded-vault}&file={encoded-path}&block={block-id}
	 *
	 * Error handling: URI generation failures are logged as warnings but do not
	 * prevent task sync (graceful degradation). Tasks without block IDs will sync
	 * successfully but without the Obsidian URI.
	 */
	private async createTaskOnCalDAV(task: Task): Promise<void> {
		// Convert task to VTODO format (T037)
		const vtodoData = taskToVTODO(task);

		// Process hyperlinks according to setting (005-hyperlink-sync-config)
		const processed = processDescription(vtodoData.summary, this.config.hyperlinkSyncMode);

		// Generate Obsidian URI with error handling (T013-T018)
		// This provides a clickable deep link in CalDAV clients to open Obsidian
		// directly to the task location within the source note.
		let description: string | undefined;
		try {
			// Get vault name from Obsidian API (T014)
			const vaultName = this.vault.getName();

			// Validate block ID before attempting URI generation (T015)
			if (!task.blockId) {
				Logger.warn('Skipping URI generation: task missing block ID');
			} else {
				// Generate URI and format DESCRIPTION (T016)
				const uri = buildObsidianURI(vaultName, task.filePath, task.blockId);
				description = buildDescriptionWithURI(uri, processed.extractedLinksBlock || undefined);
			}
		} catch (error) {
			// Log warning but continue task creation - graceful degradation (T018)
			Logger.warn(`Failed to generate Obsidian URI for task: ${error instanceof Error ? error.message : String(error)}`);
		}

		// If no URI was generated but we have extracted links, still populate description
		if (!description && processed.extractedLinksBlock) {
			description = processed.extractedLinksBlock;
		}

		// Route new tasks to the default calendar (design D4)
		const targetCalendarUrl = this.config.defaultCalendar?.url ?? "";
		if (!targetCalendarUrl) {
			throw new Error(
				"Cannot create CalDAV task: no default calendar configured. " +
				'Please click "Discover calendars" in settings and select a default calendar.',
			);
		}

		// Create task on CalDAV server with optional description (T017, T038)
		const caldavTask = await this.client.createTask(
			targetCalendarUrl,
			processed.summary,
			vtodoData.due,
			vtodoData.status,
			description
		);

		Logger.debug(`Created CalDAV task: ${caldavTask.uid}`);

		// T043: Store sync mapping after successful creation (task 3.5)
		const mapping: SyncMapping = {
			blockId: task.blockId,
			caldavUid: caldavTask.uid,
			lastSyncTimestamp: new Date(),
			lastKnownContentHash: hashTaskContent(task),
			lastKnownObsidianModified: new Date(),
			lastKnownCalDAVModified: caldavTask.lastModified,
			caldavEtag: caldavTask.etag,
			caldavHref: caldavTask.href,
			calendarUrl: targetCalendarUrl,
		};

		setMapping(mapping);

		// Performance optimization: Mark dirty instead of saving immediately
		this.dirtyMappings = true;
	}

	/**
	 * Check if CalDAV data matches what we expect based on Obsidian task
	 * @param task The Obsidian task
	 * @param caldavTask The CalDAV task
	 * @returns true if reconciliation is needed (data doesn't match)
	 */
	private needsReconciliation(task: Task, caldavTask: CalDAVTask): boolean {
		// Convert task to expected VTODO format
		const expected = taskToVTODO(task);

		// Compare description
		if (expected.summary !== caldavTask.summary) {
			return true;
		}

		// Compare status
		if (expected.status !== caldavTask.status) {
			return true;
		}

		// Compare due date (normalize to date-only comparison)
		const expectedDate = expected.due
			? `${expected.due.getUTCFullYear()}-${String(
					expected.due.getUTCMonth() + 1
			  ).padStart(2, "0")}-${String(expected.due.getUTCDate()).padStart(
					2,
					"0"
			  )}`
			: null;

		const caldavDate = caldavTask.due
			? `${caldavTask.due.getUTCFullYear()}-${String(
					caldavTask.due.getUTCMonth() + 1
			  ).padStart(2, "0")}-${String(
					caldavTask.due.getUTCDate()
			  ).padStart(2, "0")}`
			: null;

		if (expectedDate !== caldavDate) {
			return true;
		}

		return false;
	}

	/**
	 * Detect if a task has changed in Obsidian since last sync
	 * Implements T046: Change detection
	 * @param task The current task from vault
	 * @param mapping The existing sync mapping
	 * @returns true if task has changed
	 */
	private detectObsidianChanges(task: Task, mapping: SyncMapping): boolean {
		// Calculate current content hash
		const currentHash = hashTaskContent(task);
		const hasChanged = currentHash !== mapping.lastKnownContentHash;

		if (hasChanged) {
			Logger.debug(`Obsidian task changed: ${task.blockId}`);
			Logger.debug(`  Current hash: ${currentHash}`);
			Logger.debug(`  Stored hash: ${mapping.lastKnownContentHash}`);
		}

		return hasChanged;
	}

	/**
	 * Detect if a task has changed on CalDAV server since last sync.
	 * Uses ETag comparison: ETags are mandatory per WebDAV (RFC 4918) and
	 * change on every server-side write, unlike the iCalendar LAST-MODIFIED
	 * property which is optional (RFC 5545) and unreliable across servers.
	 * Implements T054: Change detection for CalDAV
	 * @param caldavTask The current task from CalDAV server
	 * @param mapping The existing sync mapping
	 * @returns true if task has changed on CalDAV
	 */
	private detectCalDAVChanges(
		caldavTask: CalDAVTask,
		mapping: SyncMapping
	): boolean {
		const hasChanged = caldavTask.etag !== mapping.caldavEtag;

		if (hasChanged) {
			Logger.debug(`CalDAV task changed: ${caldavTask.uid}`);
			Logger.debug(`  Current etag: ${caldavTask.etag}`);
			Logger.debug(`  Stored etag:  ${mapping.caldavEtag}`);
		}

		return hasChanged;
	}

	/**
	 * Update a task on CalDAV server
	 * Implements T048: Update sync logic
	 * Updated for T029-T030 (002-sync-polish): Use property preservation
	 * @param task The updated task from vault
	 * @param mapping The existing sync mapping
	 */
	private async updateCalDAVTask(
		task: Task,
		mapping: SyncMapping
	): Promise<void> {
		// Validate that we have the required CalDAV metadata
		if (!mapping.caldavHref || !mapping.caldavEtag) {
			throw new Error(
				`Cannot update task: missing CalDAV metadata (href: ${mapping.caldavHref}, etag: ${mapping.caldavEtag}). ` +
					`This should have been refreshed during sync. Please try syncing again.`
			);
		}

		// Convert task to VTODO format
		const vtodoData = taskToVTODO(task);

		// Process hyperlinks for the summary only (005-hyperlink-sync-config)
		// DESCRIPTION is preserved by the property preservation pattern (feature 002)
		const processed = processDescription(vtodoData.summary, this.config.hyperlinkSyncMode);

		// Get the stored CalDAV metadata from mapping
		const caldavUid = mapping.caldavUid;
		const caldavEtag = mapping.caldavEtag;
		const caldavHref = mapping.caldavHref;

		// T029-T030: Update task using property preservation pattern
		// Route write to the calendar recorded on the mapping (design D4)
		const updatedTask = await this.client.updateTaskWithPreservation(
			caldavUid,
			processed.summary,
			vtodoData.due,
			vtodoData.status,
			caldavEtag,
			caldavHref,
			mapping.calendarUrl || undefined,
		);

		// T050: Update sync mapping timestamps and hashes after successful update
		mapping.lastSyncTimestamp = new Date();
		mapping.lastKnownContentHash = hashTaskContent(task);
		mapping.lastKnownObsidianModified = new Date();
		mapping.lastKnownCalDAVModified = updatedTask.lastModified;
		mapping.caldavEtag = updatedTask.etag;
		mapping.caldavHref = updatedTask.href;

		setMapping(mapping);

		// Performance optimization: Mark dirty instead of saving immediately
		this.dirtyMappings = true;
	}

	/**
	 * Update a task in Obsidian vault from CalDAV server
	 * Implements T056: CalDAV-to-Obsidian sync logic
	 * Implements T059: Update sync mapping timestamps
	 * @param task The existing task in the vault
	 * @param caldavTask The updated task from CalDAV server
	 * @param mapping The existing sync mapping
	 */
	private async updateObsidianTask(
		task: Task,
		caldavTask: CalDAVTask,
		mapping: SyncMapping
	): Promise<void> {
		// Convert CalDAV task to Obsidian format
		const updatedData = vtodoToTask(caldavTask);

		// 005-hyperlink-sync-config: Preserve hyperlinks on the inbound path.
		// Hyperlink processing is one-way (Obsidian → CalDAV only).  When we
		// originally pushed the task we may have stripped or moved hyperlinks
		// out of the summary; pulling that processed summary back would
		// silently destroy the hyperlinks in Obsidian.
		//
		// Guard: re-derive what we sent last time.  If the CalDAV summary
		// still matches that derived value the user did not edit the text in
		// their CalDAV client — keep the Obsidian description as the source
		// of truth.  Only adopt the CalDAV summary when it has genuinely
		// diverged (i.e. the user made an edit in their CalDAV app).
		let effectiveDescription = updatedData.description;
		if (this.config.hyperlinkSyncMode !== HyperlinkSyncMode.Keep) {
			const { summary: expectedCalDAVSummary } = processDescription(
				task.description,
				this.config.hyperlinkSyncMode
			);
			if (updatedData.description === expectedCalDAVSummary) {
				effectiveDescription = task.description;
				Logger.debug(
					`Preserved Obsidian hyperlinks for task ${task.blockId} (CalDAV summary unchanged)`
				);
			}
		}

		// 006-desc-update-control: Only apply CalDAV description when setting is enabled.
		// When disabled (default), preserve the Obsidian description as authoritative.
		// When enabled, only adopt a non-empty CalDAV value (FR-005: absent/empty = no-op).
		const descriptionToApply = this.config.syncDescriptionFromCalDAV
			? (effectiveDescription || task.description)
			: task.description;

		// Update task in vault (uses Tasks Plugin API if available)
		await updateTaskInVault(
			this.app,
			this.vault,
			task,
			descriptionToApply,
			updatedData.dueDate,
			updatedData.status
		);

		// T059: Update sync mapping timestamps after successful update
		mapping.lastSyncTimestamp = new Date();
		mapping.lastKnownContentHash = hashTaskContent(task);
		mapping.lastKnownObsidianModified = new Date();
		mapping.lastKnownCalDAVModified = caldavTask.lastModified;
		mapping.caldavEtag = caldavTask.etag;
		mapping.caldavHref = caldavTask.href;

		setMapping(mapping);

		// Performance optimization: Mark dirty instead of saving immediately
		this.dirtyMappings = true;
	}

	/**
	 * Move a mapped task from its current calendar to a different one (design D7).
	 * Implements COPY + DELETE. On copy-ok/delete-fail, keeps both copies and warns.
	 * @param blockId The Obsidian block ID of the task to move
	 * @param destinationCalendarUrl The URL of the destination calendar
	 */
	async moveTask(blockId: string, destinationCalendarUrl: string): Promise<void> {
		const mapping = getMappingByBlockId(blockId);
		if (!mapping) {
			throw new Error(`Cannot move task: no sync mapping found for block ID ${blockId}`);
		}

		if (!this.client) {
			throw new Error("Sync engine client not initialized");
		}

		await this.connectToServer();

		try {
			// Step 1: Copy VTODO to destination (design D7)
			const copiedTask = await this.client.copyTaskToCalendar(
				mapping.caldavHref,
				mapping.caldavEtag,
				destinationCalendarUrl,
			);

			// Step 2: Delete from source
			try {
				await this.client.deleteTask(
					mapping.caldavUid,
					mapping.caldavEtag,
					mapping.caldavHref,
				);
			} catch {
				// Copy succeeded but delete failed — warn user, keep mapping at original (task 7.4)
				const sourceUrl = mapping.calendarUrl;
				new Notice(
					`⚠️ Task copy succeeded but could not be deleted from the original calendar. ` +
					`The task now exists in both "${sourceUrl}" and "${destinationCalendarUrl}". ` +
					`Please resolve the duplicate manually in your CalDAV client.`,
					15000,
				);
				Logger.warn(
					`Move task ${blockId}: copy-ok but delete-fail. ` +
					`Source: ${sourceUrl}, Dest: ${destinationCalendarUrl}`,
				);
				return;
			}

			// Step 3: Update mapping
			mapping.calendarUrl = destinationCalendarUrl;
			mapping.caldavHref = copiedTask.href;
			mapping.caldavEtag = copiedTask.etag;
			setMapping(mapping);
			await this.saveData();

			Logger.info(`Moved task ${blockId} to calendar ${destinationCalendarUrl}`);
		} finally {
			await this.client.disconnect();
		}
	}

	/**
	 * Returns the discovery cache from the CalDAV client.
	 * Used by the move-task UI to list available destination calendars.
	 */
	getDiscoveryCache(): Map<string, import("tsdav").DAVCalendar> {
		return this.client.getDiscoveryCache();
	}

	/**
	 * Find a CalDAV task by matching description
	 * Used for reconciliation when mapping is lost
	 * @param caldavTasks Map of CalDAV tasks indexed by UID
	 * @param description Task description to match
	 * @returns Matching CalDAV task or undefined
	 */
	private async findCalDAVTaskByDescription(
		caldavTasks: Map<string, CalDAVTask>,
		description: string
	): Promise<CalDAVTask | undefined> {
		// Match by description (case-insensitive)
		// Note: This is still O(n) but only used during reconciliation (rare case)
		const lowerDescription = description.toLowerCase();
		for (const task of caldavTasks.values()) {
			if (task.summary.toLowerCase() === lowerDescription) {
				return task;
			}
		}
		return undefined;
	}

	/**
	 * Reconcile a task by creating a mapping to an existing CalDAV task
	 * This handles the case where blockId exists but mapping was lost
	 * @param task The Obsidian task
	 * @param caldavTask The existing CalDAV task
	 */
	private async reconcileTask(
		task: Task,
		caldavTask: CalDAVTask
	): Promise<SyncMapping> {
		Logger.info(
			`Reconciling task: ${task.description} with CalDAV UID: ${caldavTask.uid}`
		);

		// Create mapping to link Obsidian task with existing CalDAV task
		const mapping: SyncMapping = {
			blockId: task.blockId,
			caldavUid: caldavTask.uid,
			lastSyncTimestamp: new Date(),
			lastKnownContentHash: hashTaskContent(task),
			lastKnownObsidianModified: new Date(),
			lastKnownCalDAVModified: caldavTask.lastModified,
			caldavEtag: caldavTask.etag,
			caldavHref: caldavTask.href,
			calendarUrl: this.config.defaultCalendar?.url ?? "",
		};

		setMapping(mapping);

		// Persist mappings to plugin data
		await this.saveData();

		return mapping;
	}
}
