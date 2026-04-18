ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "task_root_issue_id" uuid REFERENCES "issues"("id");
--> statement-breakpoint
WITH RECURSIVE "issue_task_roots" AS (
  SELECT "id", "id" AS "root_id"
  FROM "issues"
  WHERE "parent_id" IS NULL
  UNION ALL
  SELECT "child"."id", "issue_task_roots"."root_id"
  FROM "issues" AS "child"
  INNER JOIN "issue_task_roots" ON "child"."parent_id" = "issue_task_roots"."id"
)
UPDATE "issues"
SET "task_root_issue_id" = "issue_task_roots"."root_id"
FROM "issue_task_roots"
WHERE "issues"."id" = "issue_task_roots"."id"
  AND "issues"."task_root_issue_id" IS NULL;
--> statement-breakpoint
UPDATE "issues"
SET "task_root_issue_id" = "id"
WHERE "task_root_issue_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_task_root_idx" ON "issues" ("company_id", "task_root_issue_id");
