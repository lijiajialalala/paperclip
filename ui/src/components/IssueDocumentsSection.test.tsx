// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ISSUE_BLACKBOARD_MANIFEST_KEY, type DocumentRevision, type Issue, type IssueDocument } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueDocumentsSection } from "./IssueDocumentsSection";
import { queryKeys } from "../lib/queryKeys";

const mockIssuesApi = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  listDocumentRevisions: vi.fn(),
  restoreDocumentRevision: vi.fn(),
  upsertDocument: vi.fn(),
  publishArtifact: vi.fn(),
  deleteDocument: vi.fn(),
  getDocument: vi.fn(),
}));

const markdownEditorMockState = vi.hoisted(() => ({
  emitMountEmptyChange: false,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../hooks/useAutosaveIndicator", () => ({
  useAutosaveIndicator: () => ({
    state: "idle",
    markDirty: vi.fn(),
    reset: vi.fn(),
    runSave: async (save: () => Promise<unknown>) => save(),
  }),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ hash: "" }),
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children, className }: { children: string; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock("./MarkdownEditor", async () => {
  const React = await import("react");

  return {
    MarkdownEditor: ({ value, onChange, placeholder, contentClassName }: {
      value: string;
      onChange?: (value: string) => void;
      placeholder?: string;
      contentClassName?: string;
    }) => {
      React.useEffect(() => {
        if (!markdownEditorMockState.emitMountEmptyChange) return;
        onChange?.("");
      }, []);

      return (
        <div className={contentClassName} data-testid="markdown-editor">
          <textarea
            aria-label={placeholder ?? "Markdown editor"}
            value={value}
            onChange={(event) => onChange?.(event.target.value)}
          />
          <div>{value || placeholder || ""}</div>
        </div>
      );
    },
  };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, type = "button", ...props }: ComponentProps<"button">) => (
    <button type={type} onClick={onClick} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

vi.mock("@/components/ui/dropdown-menu", async () => {
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuItem: ({ children, onClick, onSelect, disabled }: {
      children: React.ReactNode;
      onClick?: () => void;
      onSelect?: () => void;
      disabled?: boolean;
    }) => (
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          onSelect?.();
          onClick?.();
        }}
      >
        {children}
      </button>
    ),
    DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuRadioGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuRadioItem: ({ children, onSelect, disabled }: {
      children: React.ReactNode;
      onSelect?: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" disabled={disabled} onClick={() => onSelect?.()}>
        {children}
      </button>
    ),
    DropdownMenuSeparator: () => <hr />,
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function installLocalStorageMock() {
  const store = new Map<string, string>();
  const mock: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: mock,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setControlValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function createIssueDocument(overrides: Partial<IssueDocument> = {}): IssueDocument {
  return {
    id: "document-1",
    companyId: "company-1",
    issueId: "issue-1",
    key: "plan",
    title: "Plan",
    format: "markdown",
    body: "",
    latestRevisionId: "revision-4",
    latestRevisionNumber: 4,
    createdByAgentId: null,
    createdByUserId: "user-1",
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    createdAt: new Date("2026-03-31T12:00:00.000Z"),
    updatedAt: new Date("2026-03-31T12:05:00.000Z"),
    ...overrides,
  };
}

function createRevision(overrides: Partial<DocumentRevision> = {}): DocumentRevision {
  return {
    id: "revision-3",
    companyId: "company-1",
    documentId: "document-1",
    issueId: "issue-1",
    key: "plan",
    revisionNumber: 3,
    title: "Plan",
    format: "markdown",
    body: "Restored plan body",
    changeSummary: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-03-31T11:00:00.000Z"),
    ...overrides,
  };
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-807",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Plan rendering",
    description: null,
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    issueNumber: 807,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    labels: [],
    labelIds: [],
    planDocument: createIssueDocument(),
    documentSummaries: [createIssueDocument()],
    legacyPlanDocument: null,
    createdAt: new Date("2026-03-31T12:00:00.000Z"),
    updatedAt: new Date("2026-03-31T12:05:00.000Z"),
    ...overrides,
  };
}

describe("IssueDocumentsSection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    installLocalStorageMock();
    window.localStorage.clear();
    vi.clearAllMocks();
    markdownEditorMockState.emitMountEmptyChange = false;
  });

  afterEach(() => {
    container.remove();
  });

  it("shows the restored document body immediately after a revision restore", async () => {
    const blankLatestDocument = createIssueDocument({
      body: "",
      latestRevisionId: "revision-4",
      latestRevisionNumber: 4,
    });
    const restoredDocument = createIssueDocument({
      body: "Restored plan body",
      latestRevisionId: "revision-5",
      latestRevisionNumber: 5,
      updatedAt: new Date("2026-03-31T12:06:00.000Z"),
    });
    const pendingDocuments = deferred<IssueDocument[]>();
    const issue = createIssue();
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
        mutations: {
          retry: false,
        },
      },
    });

    mockIssuesApi.listDocuments
      .mockResolvedValueOnce([blankLatestDocument])
      .mockImplementation(() => pendingDocuments.promise);
    mockIssuesApi.restoreDocumentRevision.mockResolvedValue(restoredDocument);
    queryClient.setQueryData(
      queryKeys.issues.documentRevisions(issue.id, "plan"),
      [
        createRevision({ id: "revision-4", revisionNumber: 4, body: "", createdAt: new Date("2026-03-31T12:05:00.000Z") }),
        createRevision(),
      ],
    );

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection issue={issue} canDeleteDocuments={false} />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    expect(container.textContent).not.toContain("Restored plan body");

    const revisionButtons = Array.from(container.querySelectorAll("button"));
    const historicalRevisionButton = revisionButtons.find((button) => button.textContent?.includes("rev 3"));
    expect(historicalRevisionButton).toBeTruthy();

    await act(async () => {
      historicalRevisionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Viewing revision 3");
    expect(container.textContent).toContain("Restored plan body");

    const restoreButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Restore this revision"));
    expect(restoreButton).toBeTruthy();

    await act(async () => {
      restoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockIssuesApi.restoreDocumentRevision).toHaveBeenCalledWith("issue-1", "plan", "revision-3");
    expect(container.textContent).toContain("Restored plan body");
    expect(container.textContent).not.toContain("Viewing revision 3");

    pendingDocuments.resolve([restoredDocument]);
    await flush();
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("ignores mount-time editor change noise before a document is actively being edited", async () => {
    markdownEditorMockState.emitMountEmptyChange = true;

    const document = createIssueDocument({
      body: "Loaded plan body",
    });
    const issue = createIssue();
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
        mutations: {
          retry: false,
        },
      },
    });

    mockIssuesApi.listDocuments.mockResolvedValue([document]);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection issue={issue} canDeleteDocuments={false} />
        </QueryClientProvider>,
      );
    });

    await flush();
    await flush();

    expect(container.textContent).toContain("Loaded plan body");
    expect(container.textContent).not.toContain("Markdown body");

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("publishes a document handoff from the document actions menu", async () => {
    const document = createIssueDocument({
      key: "prd",
      title: "PRD",
      body: "Product requirements",
      latestRevisionId: "revision-prd",
    });
    const issue = createIssue({
      parentId: "issue-parent",
      ancestors: [
        {
          id: "issue-parent",
          identifier: "PAP-800",
          title: "Parent issue",
          description: null,
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
          projectId: null,
          goalId: null,
          project: null,
          goal: null,
        },
      ],
      planDocument: null,
      documentSummaries: [document],
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    mockIssuesApi.listDocuments.mockResolvedValue([document]);
    mockIssuesApi.publishArtifact.mockResolvedValue({
      ok: true,
      artifact: { kind: "document", title: "PRD", summary: "Product requirements" },
      syncedProjectDocs: { relativePath: "docs/prd.md", workspaceRoot: "C:/repo" },
      publishedTo: [
        {
          issueId: "issue-parent",
          identifier: "PAP-800",
          workProductId: "wp-1",
          commentId: "comment-1",
        },
      ],
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection issue={issue} canDeleteDocuments={false} />
        </QueryClientProvider>,
      );
    });

    await flush();
    await flush();

    const openPublishButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Publish handoff..."));
    expect(openPublishButton).toBeTruthy();

    await act(async () => {
      openPublishButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const publishButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Publish handoff");
    expect(publishButton).toBeTruthy();

    await act(async () => {
      publishButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockIssuesApi.publishArtifact).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({
        artifact: { kind: "document", key: "prd" },
        target: { mode: "parent" },
        syncToProjectDocs: { path: "docs/prd.md" },
      }),
    );
    expect(container.textContent).toContain("Published prd to 1 issue.");

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("hides reserved blackboard documents from the generic documents panel", async () => {
    const visibleDocument = createIssueDocument({
      id: "document-prd",
      key: "prd",
      title: "PRD",
      body: "Product requirements",
      latestRevisionId: "revision-prd",
    });
    const blackboardDocument = createIssueDocument({
      id: "document-source-matrix",
      key: "source-matrix",
      title: "Source matrix",
      format: "json",
      body: "{\"sources\":[]}",
      latestRevisionId: "revision-source-matrix",
    });
    const issue = createIssue({
      planDocument: null,
      documentSummaries: [visibleDocument, blackboardDocument],
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    mockIssuesApi.listDocuments.mockResolvedValue([visibleDocument, blackboardDocument]);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection issue={issue} canDeleteDocuments={false} />
        </QueryClientProvider>,
      );
    });

    await flush();
    await flush();

    expect(container.textContent).toContain("prd");
    expect(container.textContent).toContain("Product requirements");
    expect(container.textContent).not.toContain("source-matrix");
    expect(container.textContent).not.toContain("{\"sources\":[]}");

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  });

  it("rejects reserved blackboard keys when creating a generic document", async () => {
    const issue = createIssue({
      planDocument: null,
      documentSummaries: [],
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    mockIssuesApi.listDocuments.mockResolvedValue([]);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDocumentsSection issue={issue} canDeleteDocuments={false} />
        </QueryClientProvider>,
      );
    });

    await flush();
    await flush();

    const newDocumentButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("New document"));
    expect(newDocumentButton).toBeTruthy();

    await act(async () => {
      newDocumentButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const keyInput = container.querySelector('input[placeholder="Document key"]') as HTMLInputElement | null;
    const bodyInput = container.querySelector('textarea[aria-label="Markdown body"]') as HTMLTextAreaElement | null;

    expect(keyInput).toBeTruthy();
    expect(bodyInput).toBeTruthy();

    await act(async () => {
      if (keyInput) {
        setControlValue(keyInput, ISSUE_BLACKBOARD_MANIFEST_KEY);
      }
      if (bodyInput) {
        setControlValue(bodyInput, "{\"status\":\"ready\"}");
      }
    });
    await flush();

    expect(container.textContent).toContain("This key is reserved for issue blackboards");

    const createButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create document"));
    expect(createButton).toBeTruthy();

    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockIssuesApi.upsertDocument).not.toHaveBeenCalled();
    expect(container.textContent).toContain("This document key is reserved for issue blackboards");

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  });
});
