CREATE TABLE `card_setup` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`customer_ref` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`follow_up_link` text,
	`return_url` text NOT NULL,
	`replaces_card_id` text,
	`payment_amount` integer,
	`payment_reference` text,
	`payment_items` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`replaces_card_id`) REFERENCES `card`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `card_setup_project_customer_idx` ON `card_setup` (`project_id`,`customer_ref`);--> statement-breakpoint
ALTER TABLE `charge` ADD `items` text;--> statement-breakpoint
ALTER TABLE `invoice` ADD `items` text;