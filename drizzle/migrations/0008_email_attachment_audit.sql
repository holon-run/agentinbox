CREATE TABLE `email_attachment_audit_events` (
  `audit_id` text PRIMARY KEY NOT NULL,
  `attachment_ref` text NOT NULL,
  `claimed_agent_id` text NOT NULL,
  `inbox_id` text,
  `item_id` text,
  `source_id` text,
  `action` text NOT NULL,
  `result` text NOT NULL,
  `error_code` text,
  `bytes` integer,
  `sha256` text,
  `created_at` text NOT NULL
);
CREATE INDEX `idx_email_attachment_audit_attachment` ON `email_attachment_audit_events` (`attachment_ref`,`created_at`);
CREATE INDEX `idx_email_attachment_audit_item` ON `email_attachment_audit_events` (`item_id`,`created_at`);
CREATE INDEX `idx_email_attachment_audit_created` ON `email_attachment_audit_events` (`created_at`);
