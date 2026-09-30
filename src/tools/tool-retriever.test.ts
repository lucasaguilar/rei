import { describe, it, expect } from "vitest";
import { searchMcpTools, PRELOAD_K } from "./tool-retriever.js";
import type { McpTool } from "./mcp/mcp-client.js";

// A slice of the GitHub MCP server's 40 tools, with its own descriptions. Asked "hace un PR de
// feat/MCP-SAFETY-GATE a main", the preload offered pull_request_review_write, create_or_update_file
// and add_issue_comment but not create_pull_request; the model reached for what it had, called the
// review tool twice, and tried to "probe" with a file write the user had to decline.
const t = (name: string, description: string): McpTool => ({ name: `github/${name}`, description });
const GITHUB: McpTool[] = [
  t("add_issue_comment", "Add a comment to a specific issue in a GitHub repository."),
  t("add_reply_to_pull_request_comment", "Add a reply to an existing pull request comment."),
  t("assign_copilot_to_issue", "Assign Copilot to a specific issue in a GitHub repository."),
  t("create_branch", "Create a new branch in a GitHub repository."),
  t("create_issue", "Create a new issue in a GitHub repository."),
  t("create_or_update_file", "Create or update a single file in a GitHub repository."),
  t("create_pull_request", "Create a new pull request in a GitHub repository."),
  t("get_me", "Get details of the authenticated GitHub user."),
  t("list_pull_requests", "List pull requests in a GitHub repository."),
  t("merge_pull_request", "Merge a pull request in a GitHub repository."),
  t("pull_request_read", "Get information on a specific pull request in a GitHub repository."),
  t("pull_request_review_write", "Create and/or submit, delete review of a pull request."),
  t("push_files", "Push multiple files to a GitHub repository in a single commit."),
  t("request_copilot_review", "Request a GitHub Copilot code review for a pull request."),
  t("search_code", "Fast and precise code search across ALL GitHub repositories."),
  t("search_pull_requests", "Search for pull requests in GitHub repositories."),
  t("search_repositories", "Find GitHub repositories by name, description, readme, topics."),
  t("update_pull_request", "Update an existing pull request in a GitHub repository."),
];

const top = (query: string) => searchMcpTools(query, GITHUB, PRELOAD_K).map((x) => x.name);

describe("searchMcpTools — pull requests", () => {
  for (const query of [
    "hace un PR de feat/MCP-SAFETY-GATE a main",
    "crea el PR desde feat/MCP-SAFETY-GATE a main porfavor",
    "open a pull request for this branch",
    "abrí un pull request a main",
  ]) {
    it(`puts create_pull_request first for: ${query}`, () => {
      expect(top(query)[0]).toBe("github/create_pull_request");
    });
  }

  it("still ranks the listing tool first when the request is to list", () => {
    expect(top("list my open pull requests")[0]).toBe("github/list_pull_requests");
  });

  it("does not lift pull-request tools for an unrelated request", () => {
    expect(top("search code for the tokenizer")[0]).toBe("github/search_code");
  });
});
