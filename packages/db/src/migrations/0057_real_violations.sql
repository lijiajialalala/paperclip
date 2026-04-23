ALTER TABLE "routines" ADD COLUMN "execution_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "execution_workspace_preference" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "execution_workspace_settings" jsonb;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routines_company_execution_workspace_idx" ON "routines" USING btree ("company_id","execution_workspace_id");
