CREATE TABLE IF NOT EXISTS "issue_reply_needed" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "comment_id" uuid NOT NULL REFERENCES "issue_comments"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_reply_needed_company_user_idx" ON "issue_reply_needed" ("company_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_reply_needed_company_issue_idx" ON "issue_reply_needed" ("company_id","issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_reply_needed_company_comment_idx" ON "issue_reply_needed" ("company_id","comment_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_reply_needed_company_issue_user_idx" ON "issue_reply_needed" ("company_id","issue_id","user_id");
