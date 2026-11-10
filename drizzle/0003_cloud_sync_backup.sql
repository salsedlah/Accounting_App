CREATE TABLE "cloud_backup_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid,
	"auto_sync" boolean DEFAULT true NOT NULL,
	"auto_backup" boolean DEFAULT true NOT NULL,
	"backup_interval_hours" integer DEFAULT 24 NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_backup_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid,
	"created_by_user_id" uuid,
	"kind" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"format_version" integer DEFAULT 1 NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"checksum" text NOT NULL,
	"storage_path" text,
	"data" jsonb,
	"metadata" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"restored_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid,
	"table_name" text NOT NULL,
	"record_id" text NOT NULL,
	"operation" text NOT NULL,
	"payload" jsonb,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" text
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid,
	"device_id" text NOT NULL,
	"last_change_id" bigint DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "owner_auth_user_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_user_id" uuid;--> statement-breakpoint
ALTER TABLE "cloud_backup_settings" ADD CONSTRAINT "cloud_backup_settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_backups" ADD CONSTRAINT "cloud_backups_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_backups" ADD CONSTRAINT "cloud_backups_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_changes" ADD CONSTRAINT "sync_changes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_backup_settings_business_uq" ON "cloud_backup_settings" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "cloud_backups_business_created_idx" ON "cloud_backups" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "cloud_backups_user_created_idx" ON "cloud_backups" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_backups_checksum_uq" ON "cloud_backups" USING btree ("business_id","checksum");--> statement-breakpoint
CREATE INDEX "sync_changes_business_id_idx" ON "sync_changes" USING btree ("business_id","id");--> statement-breakpoint
CREATE INDEX "sync_changes_record_idx" ON "sync_changes" USING btree ("table_name","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_cursors_business_device_uq" ON "sync_cursors" USING btree ("business_id","device_id");--> statement-breakpoint
CREATE INDEX "sync_cursors_business_idx" ON "sync_cursors" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_auth_user_id_uq" ON "users" USING btree ("auth_user_id");
