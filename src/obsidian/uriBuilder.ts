/**
 * URI Builder Service
 * Generates Obsidian deep links from task metadata.
 */

// Regular expression for validating block ID format: task-{uuid}
const BLOCK_ID_REGEX = /^task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Validates that a block ID matches the expected UUID format.
 *
 * Valid format: "task-" followed by a UUID v4 (lowercase hex with dashes)
 * Example: "task-a1b2c3d4-e5f6-7890-abcd-ef1234567890"
 *
 * @param blockId - The block ID to validate
 * @returns true if valid, false otherwise
 *
 * @example
 * ```typescript
 * isValidBlockId("task-a1b2c3d4-e5f6-7890-abcd-ef1234567890")  // true
 * isValidBlockId("task-invalid")                               // false
 * isValidBlockId("")                                           // false
 * ```
 */
export function isValidBlockId(blockId: string): boolean {
	return BLOCK_ID_REGEX.test(blockId);
}

/**
 * Builds an Obsidian Advanced URI for navigating to a specific block.
 *
 * Constructs a deep link in the format:
 * `obsidian://advanced-uri?vault={VaultName}&block={BlockID}`
 *
 * Requires the Advanced URI community plugin to be installed in the vault.
 *
 * @param vaultName - The name of the Obsidian vault (from vault.getName())
 * @param blockId - Task block identifier (format: "task-{uuid}")
 * @returns Fully formatted Advanced URI
 * @throws Error if blockId is invalid or vaultName is empty
 *
 * @example
 * ```typescript
 * buildAdvancedURI("My Vault", "task-a1b2c3d4-e5f6-7890-abcd-ef1234567890")
 * // Returns: "obsidian://advanced-uri?vault=My%20Vault&block=task-a1b2c3d4-e5f6-7890-abcd-ef1234567890"
 * ```
 */
export function buildAdvancedURI(
	vaultName: string,
	blockId: string
): string {
	if (!vaultName || vaultName.trim() === '') {
		throw new Error('Vault name is required');
	}
	if (!blockId || !isValidBlockId(blockId)) {
		throw new Error('Invalid block ID format');
	}

	const encodedVault = encodeURIComponent(vaultName);
	return `obsidian://advanced-uri?vault=${encodedVault}&block=${blockId}`;
}

/**
 * Builds the DESCRIPTION field content with Obsidian URI appended as a markdown link.
 *
 * @param uri - The Obsidian Advanced URI (from buildAdvancedURI)
 * @param existingContent - Optional existing DESCRIPTION content to preserve
 * @returns Formatted DESCRIPTION field value (NOT yet RFC 5545 escaped)
 *
 * @example
 * ```typescript
 * buildDescriptionWithURI("obsidian://advanced-uri?vault=V&block=B")
 * // Returns: "[Open in Obsidian](obsidian://advanced-uri?vault=V&block=B)"
 * ```
 *
 * @remarks
 * Caller must apply RFC 5545 TEXT escaping before embedding in VTODO.
 */
export function buildDescriptionWithURI(
	uri: string,
	existingContent?: string
): string {
	const link = `[Open in Obsidian](${uri})`;
	if (existingContent) {
		return `${existingContent}\n\n${link}`;
	}
	return link;
}
