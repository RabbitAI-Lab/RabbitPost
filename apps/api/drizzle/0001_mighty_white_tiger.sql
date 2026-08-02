CREATE TABLE "scenario_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scenario_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"request" jsonb NOT NULL,
	"source_item_id" uuid,
	"source_snapshot_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collection_items" ADD COLUMN "is_scenario_root" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scenario_steps" ADD CONSTRAINT "scenario_steps_scenario_id_collection_items_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."collection_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenario_steps" ADD CONSTRAINT "scenario_steps_source_item_id_collection_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."collection_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scenario_steps_scenario_idx" ON "scenario_steps" USING btree ("scenario_id");