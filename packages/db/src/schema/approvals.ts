import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    type: text("type").notNull(),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id),
    requestedByUserId: text("requested_by_user_id"),
    targetAgentId: uuid("target_agent_id").references(() => agents.id),
    targetUserId: text("target_user_id"),
    routingMode: text("routing_mode").notNull().default("board_pool"),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    decisionNote: text("decision_note"),
    decidedByUserId: text("decided_by_user_id"),
    decidedByAgentId: uuid("decided_by_agent_id").references(() => agents.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    escalationReason: text("escalation_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusTypeIdx: index("approvals_company_status_type_idx").on(
      table.companyId,
      table.status,
      table.type,
    ),
    companyStatusRoutingIdx: index("approvals_company_status_routing_idx").on(
      table.companyId,
      table.status,
      table.routingMode,
    ),
    companyStatusTargetAgentIdx: index("approvals_company_status_target_agent_idx").on(
      table.companyId,
      table.status,
      table.targetAgentId,
    ),
    companyStatusTargetUserIdx: index("approvals_company_status_target_user_idx").on(
      table.companyId,
      table.status,
      table.targetUserId,
    ),
  }),
);
