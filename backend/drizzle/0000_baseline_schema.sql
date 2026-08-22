CREATE TABLE `agents` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`world_name` text,
	`group` text,
	`config_file` text,
	`profile_pic` text,
	`in_a_nutshell` text,
	`characteristics` text,
	`recent_events` text,
	`system_prompt` text NOT NULL,
	`interrupt_every_turn` integer,
	`priority` integer,
	`transparent` integer,
	`created_at` DATETIME
);
--> statement-breakpoint
CREATE INDEX `ix_agents_id` ON `agents` (`id`);--> statement-breakpoint
CREATE INDEX `ix_agents_name` ON `agents` (`name`);--> statement-breakpoint
CREATE INDEX `ix_agents_world_name` ON `agents` (`world_name`);--> statement-breakpoint
CREATE INDEX `ix_agents_group` ON `agents` (`group`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_agents_name_world` ON `agents` (`name`,`world_name`);--> statement-breakpoint
CREATE TABLE `alembic_version` (
	`version_num` text(32) PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `locations` (
	`id` integer PRIMARY KEY NOT NULL,
	`world_id` integer NOT NULL,
	`name` text NOT NULL,
	`display_name` text,
	`description` text,
	`label` text,
	`position_x` integer,
	`position_y` integer,
	`adjacent_locations` text,
	`room_id` integer,
	`is_current` integer,
	`is_discovered` integer,
	`is_draft` integer,
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_locations_id` ON `locations` (`id`);--> statement-breakpoint
CREATE INDEX `ix_location_world` ON `locations` (`world_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY NOT NULL,
	`room_id` integer NOT NULL,
	`agent_id` integer,
	`content` text NOT NULL,
	`role` text(9) NOT NULL,
	`participant_type` text,
	`participant_name` text,
	`thinking` text,
	`anthropic_calls` text,
	`timestamp` DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`image_data` text,
	`image_media_type` text,
	`images` text,
	`chat_session_id` integer,
	`game_time_snapshot` text,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_messages_id` ON `messages` (`id`);--> statement-breakpoint
CREATE INDEX `ix_messages_chat_session_id` ON `messages` (`chat_session_id`);--> statement-breakpoint
CREATE INDEX `idx_message_room_id` ON `messages` (`room_id`);--> statement-breakpoint
CREATE INDEX `idx_message_agent_id` ON `messages` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_message_room_timestamp` ON `messages` (`room_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_message_chat_session` ON `messages` (`room_id`,`chat_session_id`);--> statement-breakpoint
CREATE TABLE `player_states` (
	`id` integer PRIMARY KEY NOT NULL,
	`world_id` integer NOT NULL,
	`current_location_id` integer,
	`turn_count` integer,
	`stats` text,
	`inventory` text,
	`effects` text,
	`action_history` text,
	`is_chat_mode` integer,
	`chat_mode_start_message_id` integer,
	`chat_session_id` integer,
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`current_location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `player_states_world_id_unique` ON `player_states` (`world_id`);--> statement-breakpoint
CREATE INDEX `ix_player_states_id` ON `player_states` (`id`);--> statement-breakpoint
CREATE TABLE `room_agent_sessions` (
	`room_id` integer NOT NULL,
	`agent_id` integer NOT NULL,
	`session_id` text NOT NULL,
	`updated_at` DATETIME,
	PRIMARY KEY(`room_id`, `agent_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `room_agents` (
	`room_id` integer NOT NULL,
	`agent_id` integer NOT NULL,
	`joined_at` DATETIME,
	PRIMARY KEY(`room_id`, `agent_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` integer PRIMARY KEY NOT NULL,
	`owner_id` text,
	`name` text NOT NULL,
	`max_interactions` integer,
	`is_paused` integer DEFAULT 0,
	`is_finished` integer DEFAULT 0,
	`created_at` DATETIME,
	`last_activity_at` DATETIME,
	`last_read_at` DATETIME,
	`world_id` integer,
	FOREIGN KEY (`world_id`) REFERENCES `worlds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_rooms_id` ON `rooms` (`id`);--> statement-breakpoint
CREATE INDEX `ix_rooms_name` ON `rooms` (`name`);--> statement-breakpoint
CREATE INDEX `ix_rooms_owner_id` ON `rooms` (`owner_id`);--> statement-breakpoint
CREATE INDEX `ix_rooms_last_activity_at` ON `rooms` (`last_activity_at`);--> statement-breakpoint
CREATE INDEX `ix_rooms_world_id` ON `rooms` (`world_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_rooms_owner_name_world` ON `rooms` (`owner_id`,`name`,`world_id`);--> statement-breakpoint
CREATE TABLE `worlds` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_id` text,
	`user_name` text,
	`language` text(2),
	`phase` text(10),
	`genre` text,
	`theme` text,
	`stat_definitions` text,
	`onboarding_room_id` integer,
	`created_at` DATETIME,
	`updated_at` DATETIME,
	`last_played_at` DATETIME,
	FOREIGN KEY (`onboarding_room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_worlds_id` ON `worlds` (`id`);--> statement-breakpoint
CREATE INDEX `ix_worlds_name` ON `worlds` (`name`);--> statement-breakpoint
CREATE INDEX `ix_worlds_owner_id` ON `worlds` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_worlds_owner_name` ON `worlds` (`owner_id`,`name`);