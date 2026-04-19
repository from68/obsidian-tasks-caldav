import { App, Modal, Setting } from "obsidian";
import { DiscoveredCalendar } from "../types";

/**
 * Modal for picking a destination calendar when moving a task
 */
export class CalendarPickerModal extends Modal {
	private calendars: DiscoveredCalendar[];
	private onChoose: (calendarUrl: string) => void;
	private title: string;

	constructor(
		app: App,
		calendars: DiscoveredCalendar[],
		onChoose: (calendarUrl: string) => void,
		title = "Move task to calendar",
	) {
		super(app);
		this.calendars = calendars;
		this.onChoose = onChoose;
		this.title = title;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.title });

		if (this.calendars.length === 0) {
			contentEl.createEl("p", {
				text: 'No calendars available. Click "Discover calendars" in settings first.',
			});
			return;
		}

		for (const cal of this.calendars) {
			new Setting(contentEl)
				.setName(cal.displayName)
				.setDesc(cal.url)
				.addButton((btn) =>
					btn
						.setButtonText("Move here")
						.setCta()
						.onClick(() => {
							this.close();
							this.onChoose(cal.url);
						}),
				);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
