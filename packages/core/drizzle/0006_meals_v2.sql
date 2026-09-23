-- Meals v2: the Groceries feature (derived list, pantry, extras) and the
-- recipe/meal-plan model are scrapped. Meals are now imported by the AI from
-- pasted recipes (breakfast/lunch + plain ingredient lines), optionally paired
-- into suites, and cook blocks get an explicit assignment. The old tables are
-- dropped (live data at time of writing: zero recipes/plans/extras, 3 pantry
-- staples — all feature-less after the scrap).
DROP TABLE IF EXISTS `grocery_extra`;
--> statement-breakpoint
DROP TABLE IF EXISTS `pantry`;
--> statement-breakpoint
DROP TABLE IF EXISTS `meal_plan`;
--> statement-breakpoint
DROP TABLE IF EXISTS `ingredient`;
--> statement-breakpoint
DROP TABLE IF EXISTS `recipe`;
--> statement-breakpoint
CREATE TABLE `meal` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`meal_type` text NOT NULL,
	`ingredients` text NOT NULL,
	`details` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `meal_name_idx` ON `meal` (`name`);
--> statement-breakpoint
CREATE TABLE `meal_suite` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`breakfast_meal_id` text NOT NULL,
	`lunch_meal_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`breakfast_meal_id`) REFERENCES `meal`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lunch_meal_id`) REFERENCES `meal`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `cook_assignment` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`date` text NOT NULL,
	`suite_id` text,
	`meal_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`suite_id`) REFERENCES `meal_suite`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`meal_id`) REFERENCES `meal`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cook_assignment_evt_idx` ON `cook_assignment` (`event_id`,`date`);
--> statement-breakpoint
CREATE INDEX `cook_assignment_date_idx` ON `cook_assignment` (`date`);
