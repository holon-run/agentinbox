CREATE TABLE `email_body_cache` (
  `entry_id` text PRIMARY KEY NOT NULL,
  `inbox_id` text NOT NULL,
  `item_id` text NOT NULL,
  `source_id` text NOT NULL,
  `content_version` text NOT NULL,
  `schema_version` integer NOT NULL,
  `parser_version` text NOT NULL,
  `text` text NOT NULL,
  `bytes` integer NOT NULL,
  `completeness` text NOT NULL,
  `reasons_json` text NOT NULL,
  `created_at` text NOT NULL,
  `expires_at` text NOT NULL,
  `last_accessed_at` text NOT NULL
);
CREATE INDEX `idx_email_body_cache_inbox_entry` ON `email_body_cache` (`inbox_id`,`entry_id`);
CREATE INDEX `idx_email_body_cache_expiry` ON `email_body_cache` (`expires_at`);
CREATE INDEX `idx_email_body_cache_access` ON `email_body_cache` (`last_accessed_at`);
