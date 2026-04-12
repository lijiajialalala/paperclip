import type { Approval, ApprovalComment, Issue } from "@paperclipai/shared";
import { api } from "./client";

type ApprovalListOptions = {
  status?: string;
  scope?: "mine" | "all";
};

export const approvalsApi = {
  list: (companyId: string, options?: ApprovalListOptions) => {
    const params = new URLSearchParams();
    if (options?.status) {
      params.set("status", options.status);
    }
    if (options?.scope) {
      params.set("scope", options.scope);
    }
    const query = params.toString();
    return api.get<Approval[]>(
      `/companies/${companyId}/approvals${query ? `?${query}` : ""}`,
    );
  },
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Approval>(`/companies/${companyId}/approvals`, data),
  get: (id: string) => api.get<Approval>(`/approvals/${id}`),
  approve: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/approve`, { decisionNote }),
  reject: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/reject`, { decisionNote }),
  requestRevision: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/request-revision`, { decisionNote }),
  resubmit: (id: string, payload?: Record<string, unknown>) =>
    api.post<Approval>(`/approvals/${id}/resubmit`, { payload }),
  listComments: (id: string) => api.get<ApprovalComment[]>(`/approvals/${id}/comments`),
  addComment: (id: string, body: string) =>
    api.post<ApprovalComment>(`/approvals/${id}/comments`, { body }),
  listIssues: (id: string) => api.get<Issue[]>(`/approvals/${id}/issues`),
};
