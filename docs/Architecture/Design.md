# Architecture Design: CMPA-9 QA Result Write-back

**Author:** Tech Lead (4c62b9c0-efa2-4343-afbd-55cc61eb1650)
**Status:** Final

## 1. Overview

This document outlines the architectural changes required to fix issue CMPA-9, where acceptance test conclusions from QA runs are not automatically written back to the associated issue. The solution involves modifications to the backend/QA agent and the frontend UI to provide a seamless, automated reporting flow.

## 2. Problem Statement

The current process lacks a mechanism for automated QA results to be posted on the relevant issue, requiring manual intervention. This delays feedback loops and reduces the efficiency of the development lifecycle.

## 3. Solution Design

### 3.1. Backend & QA Agent

The core of the solution is to empower the QA automation process to communicate its results back to the Paperclip system.

#### 3.1.1. Data Models

We will introduce two new data structures.

1.  **`QaSummary`**: To be stored with the issue details.
    ```json
    {
      "verdict": "pass" | "fail",
      "summaryText": "string",
      "reportUrl": "string",
      "alertOpen": "boolean"
    }
    ```
2.  **`IssueWriteback`**: To be stored with the activity/run log.
    ```json
    {
      "status": "success" | "failed",
      "timestamp": "date-time",
      "error": "string | null"
    }
    ```

#### 3.1.2. API Changes

A new API endpoint will be created for the QA agent to post its results.

-   **Endpoint:** `POST /api/issues/{issueId}/qa-result`
-   **Permissions:** The QA agent will be granted a token with the necessary scope to call this endpoint.
-   **Body:** The request body will contain the `QaSummary` object.
-   **Behavior:** On receiving a request, the backend will:
    1.  Validate the payload.
    2.  Update the target issue with the `QaSummary` object.
    3.  Post a comment to the issue thread on behalf of the QA agent, containing the summary.
    4.  Log the `IssueWriteback` status in the corresponding QA agent run activity.

The main issue endpoint will be updated to include the `qaSummary` field in its response.
-   **Endpoint:** `GET /api/issues/{issueId}`

### 3.2. Frontend

The UI will be updated to visualize the new QA information.

1.  **API Client (`ui/src/api/`)**: The client-side data models will be updated to include `qaSummary` for issues and `issueWriteback` for activities.

2.  **Issue Detail Page (`ui/src/pages/IssueDetail.tsx`)**:
    -   A new **`QaSummary`** component will be created to display the QA verdict, summary text, and a link to the full report.
    -   If `qaSummary.alertOpen` is `true`, a high-visibility warning banner will be displayed at the top of the issue.

3.  **Activity & Run Views (`ui/src/pages/AgentDetail.tsx`, `ui/src/components/ActivityRow.tsx`)**:
    -   A status badge will be added to display the `issueWriteback.status` (e.g., "Writeback: Success").

4.  **Comment Thread (`ui/src/components/CommentThread.tsx`)**:
    -   Comments originating from the QA agent will be visually distinguished, for example, by adding a "QA Bot" or "Platform Writeback" label.

## 4. Tasks

-   **Backend:** [CMPA-9-Backend](#) - Implement the new `qa-result` API endpoint and associated logic.
-   **Frontend:** [CMPA-9-Frontend](#) - Implement the UI changes to display QA results.
