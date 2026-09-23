CREATE TABLE `chat_message` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_created_idx` ON `chat_message` (`created_at`);--> statement-breakpoint
CREATE TABLE `event` (
	`id` text PRIMARY KEY NOT NULL,
	`semester_id` text NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`rrule` text,
	`source` text NOT NULL,
	`location` text,
	`notes` text,
	FOREIGN KEY (`semester_id`) REFERENCES `semester`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `event_starts_at_idx` ON `event` (`starts_at`);--> statement-breakpoint
CREATE INDEX `event_semester_idx` ON `event` (`semester_id`);--> statement-breakpoint
CREATE TABLE `event_exception` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`original_date` text NOT NULL,
	`status` text NOT NULL,
	`override_event_id` text,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `exception_event_idx` ON `event_exception` (`event_id`,`original_date`);--> statement-breakpoint
CREATE TABLE `grocery_extra` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE TABLE `ingredient` (
	`id` text PRIMARY KEY NOT NULL,
	`recipe_id` text NOT NULL,
	`name` text NOT NULL,
	`qty` real NOT NULL,
	`unit` text NOT NULL,
	`category` text NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipe`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ingredient_recipe_idx` ON `ingredient` (`recipe_id`);--> statement-breakpoint
CREATE TABLE `meal_plan` (
	`id` text PRIMARY KEY NOT NULL,
	`week_of` text NOT NULL,
	`recipe_id` text NOT NULL,
	`cook_date` text NOT NULL,
	`servings` integer NOT NULL,
	`covers_dates` text NOT NULL,
	`cook_event_id` text,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipe`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `meal_plan_week_idx` ON `meal_plan` (`week_of`);--> statement-breakpoint
CREATE TABLE `pantry` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`qty` real NOT NULL,
	`unit` text NOT NULL,
	`category` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `proposal` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`user_message` text NOT NULL,
	`tool_name` text NOT NULL,
	`tool_args` text NOT NULL,
	`diff` text NOT NULL,
	`conflicts` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`applied_at` text
);
--> statement-breakpoint
CREATE INDEX `proposal_status_idx` ON `proposal` (`status`);--> statement-breakpoint
CREATE TABLE `recipe` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`servings_base` integer NOT NULL,
	`instructions_md` text DEFAULT '' NOT NULL,
	`source_url` text,
	`tags` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `semester` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`timezone` text DEFAULT 'America/Chicago' NOT NULL
);
