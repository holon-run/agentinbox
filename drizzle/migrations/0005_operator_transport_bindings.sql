CREATE TABLE `operator_transport_bindings` (
  `binding_id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `transport` text NOT NULL,
  `operator_actor_id` text NOT NULL,
  `holon_base_url` text NOT NULL,
  `delivery_callback_url` text,
  `delivery_auth_json` text,
  `holon_auth_json` text,
  `default_route_id` text,
  `capabilities_json` text NOT NULL,
  `provider` text,
  `metadata_json` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
CREATE INDEX `idx_operator_bindings_agent_transport` ON `operator_transport_bindings` (`agent_id`,`transport`);

CREATE TABLE `operator_reply_routes` (
  `route_id` text PRIMARY KEY NOT NULL,
  `binding_id` text NOT NULL,
  `agent_id` text NOT NULL,
  `source_id` text,
  `delivery_handle_json` text NOT NULL,
  `metadata_json` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
CREATE INDEX `idx_operator_reply_routes_binding` ON `operator_reply_routes` (`binding_id`);
