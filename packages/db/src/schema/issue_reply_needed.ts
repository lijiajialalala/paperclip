import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { issueComments } from "./issue_comments.js";

export const issueReplyNeeded = pgTable(
  "issue_reply_needed",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id").notNull().references(() => issueComments.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("issue_reply_needed_company_user_idx").on(table.companyId, table.userId),
    companyIssueIdx: index("issue_reply_needed_company_issue_idx").on(table.companyId, table.issueId),
    companyCommentIdx: index("issue_reply_needed_company_comment_idx").on(table.companyId, table.commentId),
    companyIssueUserUnique: uniqueIndex("issue_reply_needed_company_issue_user_idx").on(
      table.companyId,
      table.issueId,
      table.userId,
    ),
  }),
);
