DO $$
DECLARE
  duplicate_stage_issue_ids text;
BEGIN
  SELECT string_agg(duplicate_groups.issue_ids, E'\n')
  INTO duplicate_stage_issue_ids
  FROM (
    SELECT string_agg("issues"."id"::text, ', ' ORDER BY "issues"."created_at", "issues"."id") AS issue_ids
    FROM "issues"
    WHERE "issues"."parent_id" is not null
      and "issues"."created_by_agent_id" is not null
      and "issues"."origin_kind" <> 'routine_execution'
      and "issues"."origin_id" is not null
      and btrim("issues"."origin_kind") <> ''
      and btrim("issues"."origin_id") <> ''
      and "issues"."hidden_at" is null
      and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')
    GROUP BY
      "issues"."company_id",
      "issues"."parent_id",
      "issues"."created_by_agent_id",
      coalesce("issues"."assignee_agent_id"::text, ''),
      coalesce("issues"."assignee_user_id", ''),
      "issues"."origin_kind",
      "issues"."origin_id"
    HAVING count(*) > 1
  ) AS duplicate_groups;

  IF duplicate_stage_issue_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot add issues_open_reusable_stage_identity_uq while duplicate live reusable stage identities still exist: %',
      duplicate_stage_issue_ids;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX "issues_open_reusable_stage_identity_uq" ON "issues" USING btree ("company_id","parent_id","created_by_agent_id",coalesce("assignee_agent_id"::text, ''),coalesce("assignee_user_id", ''),"origin_kind","origin_id") WHERE "issues"."parent_id" is not null
          and "issues"."created_by_agent_id" is not null
          and "issues"."origin_kind" <> 'routine_execution'
          and "issues"."origin_id" is not null
          and btrim("issues"."origin_kind") <> ''
          and btrim("issues"."origin_id") <> ''
          and "issues"."hidden_at" is null
          and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');
