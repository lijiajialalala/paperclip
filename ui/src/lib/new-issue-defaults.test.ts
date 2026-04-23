import { describe, expect, it } from "vitest";
import { buildResearchIssueDefaults, withResearchIssueDefaults } from "./new-issue-defaults";

describe("buildResearchIssueDefaults", () => {
  it("can upgrade arbitrary issue defaults to a research issue", () => {
    expect(
      withResearchIssueDefaults({
        status: "todo",
        priority: "high",
        projectId: "project-1",
      }),
    ).toEqual({
      status: "todo",
      priority: "high",
      projectId: "project-1",
      blackboardTemplate: "research_v1",
    });
  });

  it("always sets the research blackboard template", () => {
    expect(buildResearchIssueDefaults()).toEqual({
      blackboardTemplate: "research_v1",
    });
  });

  it("preserves provided assignee, project, and copy defaults", () => {
    expect(
      buildResearchIssueDefaults({
        assigneeAgentId: "agent-1",
        projectId: "project-1",
        priority: "high",
        title: "研究 AI 视频商业机会",
        description: "输出正式研究报告和行动 memo。",
      }),
    ).toEqual({
        assigneeAgentId: "agent-1",
        projectId: "project-1",
        priority: "high",
        title: "研究 AI 视频商业机会",
        description: "输出正式研究报告和行动 memo。",
        blackboardTemplate: "research_v1",
    });
  });

  it("omits nullable fields instead of leaking nulls into dialog defaults", () => {
    expect(
      buildResearchIssueDefaults({
        assigneeAgentId: null,
        assigneeUserId: null,
        projectId: null,
        title: null,
        description: null,
      }),
    ).toEqual({
      blackboardTemplate: "research_v1",
    });
  });
});
