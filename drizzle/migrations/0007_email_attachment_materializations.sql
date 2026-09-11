CREATE TABLE `email_attachment_materializations` (
  `item_id` text NOT NULL,
  `attachment_selector` text NOT NULL,
  `status` text NOT NULL,
  `last_error_code` text,
  `object_key` text,
  `sha256` text,
  `declared_content_type` text,
  `detected_content_type` text,
  `declared_size` integer,
  `stored_size` integer,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `expires_at` text,
  `deleted_at` text,
  PRIMARY KEY (`item_id`, `attachment_selector`)
);
CREATE INDEX `idx_email_attachment_materializations_object` ON `email_attachment_materializations` (`object_key`);
CREATE INDEX `idx_email_attachment_materializations_status` ON `email_attachment_materializations` (`status`,`updated_at`);
CREATE INDEX `idx_email_attachment_materializations_expiry` ON `email_attachment_materializations` (`expires_at`);
