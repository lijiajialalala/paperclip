import type {
  ApprovalEscalationReason,
  ApprovalRoutingMode,
  ApprovalStatus,
  ApprovalType,
} from "../constants.js";

export interface Approval {
  id: string;
  companyId: string;
  type: ApprovalType;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  targetAgentId: string | null;
  targetUserId: string | null;
  routingMode: ApprovalRoutingMode;
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedByAgentId: string | null;
  decidedAt: Date | null;
  escalatedAt: Date | null;
  escalationReason: ApprovalEscalationReason | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalComment {
  id: string;
  companyId: string;
  approvalId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}
