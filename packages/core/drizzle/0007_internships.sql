-- Internships tab: listings pulled from community aggregator feeds
-- (SimplifyJobs Summer2026, vanshb03 Summer2027), the application tracker
-- keyed on them, and per-source sync bookkeeping (last commit sha, so an
-- unchanged 11 MB feed is never re-downloaded). Additive only — no existing
-- table is touched. Hand-written like 0003-0006: the drizzle-kit journal
-- stopped at 0002 and regenerating from it would emit drops/re-creates of
-- existing tables.
CREATE TABLE `internship` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`company` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`locations` text NOT NULL,
	`terms` text NOT NULL,
	`category` text NOT NULL,
	`sponsorship` text,
	`active` integer DEFAULT true NOT NULL,
	`date_posted` text NOT NULL,
	`date_updated` text NOT NULL,
	`first_seen` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `internship_company_idx` ON `internship` (`company`);
--> statement-breakpoint
CREATE INDEX `internship_posted_idx` ON `internship` (`date_posted`);
--> statement-breakpoint
CREATE INDEX `internship_active_idx` ON `internship` (`active`);
--> statement-breakpoint
CREATE TABLE `internship_application` (
	`internship_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`notes` text,
	`applied_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`internship_id`) REFERENCES `internship`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `internship_source` (
	`source` text PRIMARY KEY NOT NULL,
	`last_commit_sha` text,
	`last_synced` text,
	`etag` text
);
