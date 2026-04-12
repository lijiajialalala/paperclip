ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "target_agent_id" uuid REFERENCES "agents"("id");
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "target_user_id" text;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "routing_mode" text DEFAULT 'board_pool';
--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "routing_mode" SET DEFAULT 'board_pool';
--> statement-breakpoint
UPDATE "approvals"
SET "routing_mode" = 'board_pool'
WHERE "routing_mode" IS NULL;
--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "routing_mode" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "decided_by_agent_id" uuid REFERENCES "agents"("id");
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "escalated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "escalation_reason" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_company_status_routing_idx" ON "approvals" ("company_id", "status", "routing_mode");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_company_status_target_agent_idx" ON "approvals" ("company_id", "status", "target_agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_company_status_target_user_idx" ON "approvals" ("company_id", "status", "target_user_id");
--> statement-breakpoint
WITH "work_plan_routes" AS (
  SELECT DISTINCT
    "issue_approvals"."approval_id" AS "approval_id",
    CASE
      WHEN "child"."parent_id" IS NOT NULL
        AND "parent"."assignee_agent_id" IS NOT NULL
        AND "parent"."assignee_agent_id" <> "child"."assignee_agent_id"
        THEN 'parent_assignee_agent'
      WHEN "child"."parent_id" IS NOT NULL
        AND "parent"."assignee_user_id" IS NOT NULL
        AND COALESCE("parent"."assignee_user_id", '') <> COALESCE("child"."assignee_user_id", '')
        THEN 'parent_assignee_user'
      ELSE 'board_pool'
    END AS "routing_mode",
    CASE
      WHEN "child"."parent_id" IS NOT NULL
        AND "parent"."assignee_agent_id" IS NOT NULL
        AND "parent"."assignee_agent_id" <> "child"."assignee_agent_id"
        THEN "parent"."assignee_agent_id"
      ELSE NULL
    END AS "target_agent_id",
    CASE
      WHEN "child"."parent_id" IS NOT NULL
        AND "parent"."assignee_user_id" IS NOT NULL
        AND COALESCE("parent"."assignee_user_id", '') <> COALESCE("child"."assignee_user_id", '')
        THEN "parent"."assignee_user_id"
      ELSE NULL
    END AS "target_user_id"
  FROM "issue_approvals"
  INNER JOIN "approvals" ON "approvals"."id" = "issue_approvals"."approval_id"
  INNER JOIN "issues" AS "child" ON "child"."id" = "issue_approvals"."issue_id"
  LEFT JOIN "issues" AS "parent" ON "parent"."id" = "child"."parent_id"
  WHERE "approvals"."type" = 'work_plan'
)
UPDATE "approvals"
SET
  "routing_mode" = "work_plan_routes"."routing_mode",
  "target_agent_id" = "work_plan_routes"."target_agent_id",
  "target_user_id" = "work_plan_routes"."target_user_id"
FROM "work_plan_routes"
WHERE "approvals"."id" = "work_plan_routes"."approval_id";
