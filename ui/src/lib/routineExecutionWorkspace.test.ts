import { describe, expect, it } from "vitest";
import {
  applyRoutineExecutionWorkspacePatch,
  createRoutineExecutionWorkspaceDraft,
  defaultProjectWorkspaceIdForProject,
  routineExecutionWorkspaceEquals,
} from "./routineExecutionWorkspace";

describe("routineExecutionWorkspace helpers", () => {
  it("starts from a null inheritance state", () => {
    expect(createRoutineExecutionWorkspaceDraft()).toEqual({
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: null,
    });
  });

  it("applies workspace patches without dropping sibling draft fields", () => {
    const next = applyRoutineExecutionWorkspacePatch(
      {
        title: "Routine",
        executionWorkspaceId: null,
        executionWorkspacePreference: null,
        executionWorkspaceSettings: null,
      },
      {
        executionWorkspaceId: "workspace-42",
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      },
    );

    expect(next).toEqual({
      title: "Routine",
      executionWorkspaceId: "workspace-42",
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
  });

  it("compares persisted workspace config by semantic fields", () => {
    expect(routineExecutionWorkspaceEquals(
      {
        executionWorkspaceId: "workspace-1",
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      },
      {
        executionWorkspaceId: "workspace-1",
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      },
    )).toBe(true);

    expect(routineExecutionWorkspaceEquals(
      {
        executionWorkspaceId: "workspace-1",
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      },
      {
        executionWorkspaceId: "workspace-1",
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "shared_workspace" },
      },
    )).toBe(false);
  });

  it("derives the project workspace fallback in policy-primary-first order", () => {
    expect(defaultProjectWorkspaceIdForProject({
      executionWorkspacePolicy: { defaultProjectWorkspaceId: "policy-workspace" },
      workspaces: [{ id: "primary-workspace", isPrimary: true }],
    })).toBe("policy-workspace");

    expect(defaultProjectWorkspaceIdForProject({
      executionWorkspacePolicy: { defaultProjectWorkspaceId: null },
      workspaces: [{ id: "primary-workspace", isPrimary: true }, { id: "secondary-workspace", isPrimary: false }],
    })).toBe("primary-workspace");

    expect(defaultProjectWorkspaceIdForProject({
      executionWorkspacePolicy: { defaultProjectWorkspaceId: null },
      workspaces: [{ id: "fallback-workspace", isPrimary: false }],
    })).toBe("fallback-workspace");
  });
});
