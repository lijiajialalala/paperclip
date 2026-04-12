ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "hidden_reason" text;
--> statement-breakpoint
UPDATE "issues"
SET "hidden_reason" = 'manual'
WHERE "hidden_at" IS NOT NULL
  AND "hidden_reason" IS NULL;
--> statement-breakpoint
WITH RECURSIVE "archived_project_issue_tree" AS (
  SELECT "issues"."id", "projects"."archived_at" AS "archived_at"
  FROM "issues"
  INNER JOIN "projects" ON "projects"."id" = "issues"."project_id"
  WHERE "projects"."archived_at" IS NOT NULL
  UNION
  SELECT "child"."id", "tree"."archived_at"
  FROM "issues" AS "child"
  INNER JOIN "archived_project_issue_tree" AS "tree" ON "child"."parent_id" = "tree"."id"
),
"archived_project_issue_ids" AS (
  SELECT DISTINCT "id", "archived_at"
  FROM "archived_project_issue_tree"
)
UPDATE "issues"
SET "hidden_at" = COALESCE("issues"."hidden_at", "archived_project_issue_ids"."archived_at"),
    "hidden_reason" = 'project_archived'
FROM "archived_project_issue_ids"
WHERE "issues"."id" = "archived_project_issue_ids"."id"
  AND COALESCE("issues"."hidden_reason", '') <> 'manual';
--> statement-breakpoint
CREATE TEMP TABLE "_orphaned_issue_ids" ON COMMIT DROP AS
WITH RECURSIVE "orphan_roots" AS (
  SELECT "issues"."id"
  FROM "issues"
  LEFT JOIN "projects" ON "projects"."id" = "issues"."project_id"
  WHERE "issues"."project_id" IS NOT NULL
    AND "projects"."id" IS NULL
),
"orphan_tree" AS (
  SELECT "orphan_roots"."id"
  FROM "orphan_roots"
  UNION
  SELECT "child"."id"
  FROM "issues" AS "child"
  INNER JOIN "orphan_tree" ON "child"."parent_id" = "orphan_tree"."id"
)
SELECT DISTINCT "id"
FROM "orphan_tree";
--> statement-breakpoint
CREATE TEMP TABLE "_orphaned_issue_asset_ids" ON COMMIT DROP AS
SELECT DISTINCT "issue_attachments"."asset_id" AS "id"
FROM "issue_attachments"
WHERE "issue_attachments"."issue_id" IN (SELECT "id" FROM "_orphaned_issue_ids");
--> statement-breakpoint
CREATE TEMP TABLE "_orphaned_issue_document_ids" ON COMMIT DROP AS
SELECT DISTINCT "issue_documents"."document_id" AS "id"
FROM "issue_documents"
WHERE "issue_documents"."issue_id" IN (SELECT "id" FROM "_orphaned_issue_ids");
--> statement-breakpoint
DELETE FROM "issue_comments"
WHERE "issue_id" IN (SELECT "id" FROM "_orphaned_issue_ids");
--> statement-breakpoint
DELETE FROM "issue_inbox_archives"
WHERE "issue_id" IN (SELECT "id" FROM "_orphaned_issue_ids");
--> statement-breakpoint
DELETE FROM "issue_read_states"
WHERE "issue_id" IN (SELECT "id" FROM "_orphaned_issue_ids");
--> statement-breakpoint
DELETE FROM "feedback_votes"
WHERE "issue_id" IN (SELECT "id" FROM "_orphaned_issue_ids");
--> statement-breakpoint
DELETE FROM "finance_events"
WHERE "issue_id" IN (SELECT "id" FROM "_orphaned_issue_ids");
--> statement-breakpoint
DELETE FROM "cost_events"
WHERE "issue_id" IN (SELECT "id" FROM "_orphaned_issue_ids");
--> statement-breakpoint
DELETE FROM "activity_log"
WHERE "entity_type" = 'issue'
  AND "entity_id" IN (SELECT "id"::text FROM "_orphaned_issue_ids");
--> statement-breakpoint
DELETE FROM "issues"
WHERE "id" IN (SELECT "id" FROM "_orphaned_issue_ids");
--> statement-breakpoint
DELETE FROM "assets"
WHERE "id" IN (SELECT "id" FROM "_orphaned_issue_asset_ids");
--> statement-breakpoint
DELETE FROM "documents"
WHERE "id" IN (SELECT "id" FROM "_orphaned_issue_document_ids");
