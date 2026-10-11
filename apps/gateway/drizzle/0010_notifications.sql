CREATE TABLE `notification` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`type` text NOT NULL,
	`source_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`last_status` integer,
	`last_error` text,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `notify_channel`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_channel_source_uq` ON `notification` (`channel_id`,`type`,`source_id`);--> statement-breakpoint
CREATE INDEX `notification_due_idx` ON `notification` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `notification_created_idx` ON `notification` (`created_at`);--> statement-breakpoint
CREATE TABLE `notify_channel` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`config_enc` text NOT NULL,
	`hint` text NOT NULL,
	`types` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`active_from` integer NOT NULL,
	`last_sent_at` integer,
	`last_error` text,
	`last_error_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notify_channel_project_idx` ON `notify_channel` (`project_id`);