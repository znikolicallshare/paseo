import { describe, expect, it } from "vitest";

import {
  createAzureDevOpsService,
  parseAzureDevOpsRemoteIdentity,
  type AzureCommandRunner,
} from "./azure-devops-service.js";
import type { CurrentPullRequestStatus } from "./forge-service.js";

function currentStatus(
  overrides: Partial<CurrentPullRequestStatus["forgeSpecific"]> = {},
): CurrentPullRequestStatus {
  return {
    number: 42,
    url: "https://dev.azure.com/allshareebv/eBankView/_git/paseo/pullrequest/42",
    title: "Add Azure DevOps",
    state: "open",
    baseRefName: "main",
    headRefName: "feat/azure-devops",
    isMerged: false,
    mergeable: "MERGEABLE",
    checks: [],
    checksStatus: "success",
    reviewDecision: "approved",
    forgeSpecific: {
      forge: "azure-devops",
      mergeStatus: "succeeded",
      autoCompleteEnabled: false,
      policiesStatus: "success",
      ...overrides,
    },
  };
}

describe("Azure DevOps service", () => {
  it("provides a short-lived bearer header for HTTPS clones", async () => {
    const runner: AzureCommandRunner = async (args) => {
      expect(args).toEqual([
        "account",
        "get-access-token",
        "--resource",
        "499b84ac-1321-427f-aa17-267ca6975798",
        "--query",
        "accessToken",
        "--output",
        "tsv",
      ]);
      return { stdout: "azure-token\n", stderr: "" };
    };
    const service = createAzureDevOpsService({
      runner,
      resolveAzPath: async () => "/usr/bin/az",
    });

    await expect(
      service.getGitCloneAuthorizationHeader?.({
        cwd: "/workspace",
        cloneUrl: "https://allshareebv.visualstudio.com/playground/_git/allshare-harness",
      }),
    ).resolves.toBe("AUTHORIZATION: bearer azure-token");
  });

  it("does not request an access token for SSH clones", async () => {
    const runner: AzureCommandRunner = async () => {
      throw new Error("Azure CLI should not run for SSH clone authentication");
    };
    const service = createAzureDevOpsService({
      runner,
      resolveAzPath: async () => "/usr/bin/az",
    });

    await expect(
      service.getGitCloneAuthorizationHeader?.({
        cwd: "/workspace",
        cloneUrl: "git@ssh.dev.azure.com:v3/allshareebv/playground/allshare-harness",
      }),
    ).resolves.toBeNull();
  });

  it.each([
    [
      "https://dev.azure.com/allshareebv/eBankView/_git/orders-api",
      {
        organization: "allshareebv",
        project: "eBankView",
        repository: "orders-api",
      },
    ],
    [
      "git@ssh.dev.azure.com:v3/allshareebv/eBankView/orders-api",
      {
        organization: "allshareebv",
        project: "eBankView",
        repository: "orders-api",
      },
    ],
    [
      "allshareebv@vs-ssh.visualstudio.com:v3/allshareebv/eBankView/orders-api",
      {
        organization: "allshareebv",
        project: "eBankView",
        repository: "orders-api",
      },
    ],
    [
      "https://allshareebv.visualstudio.com/eBankView/_git/orders-api",
      {
        organization: "allshareebv",
        project: "eBankView",
        repository: "orders-api",
      },
    ],
  ])("parses Azure Repos remote %s", (remote, expected) => {
    expect(parseAzureDevOpsRemoteIdentity(remote)).toEqual({
      ...expected,
      organizationUrl: "https://dev.azure.com/allshareebv",
    });
  });

  it("maps the current branch pull request into Paseo's forge model", async () => {
    const runner: AzureCommandRunner = async (args) => {
      if (args.slice(0, 4).join(" ") === "repos pr list --organization") {
        return {
          stdout: JSON.stringify([
            {
              pullRequestId: 41,
              title: "Same branch in another repository",
              status: "active",
              mergeStatus: "succeeded",
              sourceRefName: "refs/heads/feat/azure-devops",
              targetRefName: "refs/heads/main",
              labels: null,
              repository: {
                id: "target-id",
                name: "platform",
                project: { id: "project-id", name: "eBankView" },
                remoteUrl: null,
                sshUrl: null,
                defaultBranch: null,
              },
              forkSource: {
                repository: {
                  id: "other-id",
                  name: "other-repository",
                  project: { id: "project-id", name: "eBankView" },
                },
              },
            },
            {
              pullRequestId: 42,
              title: "Add Azure DevOps",
              description: "Native forge integration",
              status: "active",
              mergeStatus: "succeeded",
              isDraft: false,
              sourceRefName: "refs/heads/feat/azure-devops",
              targetRefName: "refs/heads/main",
              creationDate: "2026-09-26T10:00:00Z",
              autoCompleteSetBy: null,
              labels: [{ name: "integration" }],
              reviewers: [{ vote: 10, isRequired: true }],
              repository: {
                id: "repo-id",
                name: "paseo",
                project: { id: "project-id", name: "eBankView" },
              },
              lastMergeSourceCommit: { commitId: "abc123" },
              _links: {
                web: {
                  href: "https://dev.azure.com/allshareebv/eBankView/_git/paseo/pullrequest/42",
                },
              },
            },
          ]),
          stderr: "",
        };
      }
      if (args.slice(0, 5).join(" ") === "repos pr policy list --id") {
        return {
          stdout: JSON.stringify([
            {
              evaluationId: "policy-id",
              status: "approved",
              configuration: { isBlocking: true, type: { displayName: "Build validation" } },
            },
            {
              evaluationId: "optional-policy-id",
              status: "rejected",
              configuration: { isBlocking: false, type: { displayName: "Optional analysis" } },
            },
          ]),
          stderr: "",
        };
      }
      throw new Error(`Unexpected az command: ${args.join(" ")}`);
    };
    const service = createAzureDevOpsService({
      runner,
      resolveAzPath: async () => "/usr/bin/az",
      resolveRemoteUrl: async () => "https://dev.azure.com/allshareebv/eBankView/_git/paseo",
    });

    await expect(
      service.getCurrentPullRequestStatus({
        cwd: "/workspace/paseo",
        headRef: "feat/azure-devops",
        headSha: "abc123",
      }),
    ).resolves.toEqual({
      number: 42,
      repoOwner: "eBankView",
      repoName: "paseo",
      projectPath: "eBankView/paseo",
      url: "https://dev.azure.com/allshareebv/eBankView/_git/paseo/pullrequest/42",
      title: "Add Azure DevOps",
      state: "open",
      baseRefName: "main",
      headRefName: "feat/azure-devops",
      isMerged: false,
      isDraft: false,
      mergeable: "MERGEABLE",
      checks: [
        {
          name: "Build validation",
          status: "success",
          url: "https://dev.azure.com/allshareebv/eBankView/_git/paseo/pullrequest/42",
        },
        {
          name: "Optional analysis",
          status: "success",
          url: "https://dev.azure.com/allshareebv/eBankView/_git/paseo/pullrequest/42",
          traits: ["warning"],
        },
      ],
      checksStatus: "success",
      reviewDecision: "approved",
      forgeSpecific: {
        forge: "azure-devops",
        mergeStatus: "succeeded",
        autoCompleteEnabled: false,
        policiesStatus: "success",
      },
    });
  });

  it("creates a pull request through Azure DevOps CLI", async () => {
    const calls: string[][] = [];
    const runner: AzureCommandRunner = async (args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({
          pullRequestId: 84,
          title: "Ship it",
          description: "Description",
          status: "active",
          mergeStatus: "queued",
          isDraft: false,
          sourceRefName: "refs/heads/feat/ship",
          targetRefName: "refs/heads/main",
          creationDate: "2026-09-26T10:00:00Z",
          repository: {
            id: "repo-id",
            name: "paseo",
            project: { id: "project-id", name: "eBankView" },
          },
          _links: {
            web: {
              href: "https://dev.azure.com/allshareebv/eBankView/_git/paseo/pullrequest/84",
            },
          },
        }),
        stderr: "",
      };
    };
    const service = createAzureDevOpsService({
      runner,
      resolveAzPath: async () => "/usr/bin/az",
      resolveRemoteUrl: async () => "https://dev.azure.com/allshareebv/eBankView/_git/paseo",
      resolveContributorName: async () => "Zoran Nikolic",
    });

    await expect(
      service.createPullRequest({
        cwd: "/workspace/paseo",
        title: "Ship it",
        body: "Summary\\n- Description\\n\\n## Validation\\n- Tests passed",
        head: "feat/ship",
        base: "main",
      }),
    ).resolves.toEqual({
      number: 84,
      url: "https://dev.azure.com/allshareebv/eBankView/_git/paseo/pullrequest/84",
    });
    expect(calls).toEqual([
      [
        "repos",
        "pr",
        "create",
        "--organization",
        "https://dev.azure.com/allshareebv",
        "--project",
        "eBankView",
        "--repository",
        "paseo",
        "--source-branch",
        "feat/ship",
        "--target-branch",
        "main",
        "--title",
        "Ship it",
        "--description",
        "Summary\n- Description\n\n## Validation\n- Tests passed\n\n__Contributed on behalf of Zoran Nikolic__",
        "--output",
        "json",
        "--only-show-errors",
      ],
    ]);
  });

  it("searches repositories using the Azure CLI configured project", async () => {
    const service = createAzureDevOpsService({
      runner: async (args) => {
        expect(args).toEqual(["repos", "list", "--output", "json", "--only-show-errors"]);
        return {
          stdout: JSON.stringify([
            {
              id: "orders-id",
              name: "orders-api",
              project: { id: "project-id", name: "eBankView" },
              remoteUrl: "https://dev.azure.com/allshareebv/eBankView/_git/orders-api",
            },
            {
              id: "payments-id",
              name: "payments-api",
              project: { id: "project-id", name: "eBankView" },
              remoteUrl: "https://dev.azure.com/allshareebv/eBankView/_git/payments-api",
            },
          ]),
          stderr: "",
        };
      },
      resolveAzPath: async () => "/usr/bin/az",
    });

    await expect(
      service.searchForgeRepositories?.({ cwd: "/home/user", query: "orders", limit: 10 }),
    ).resolves.toEqual([
      {
        forge: "azure-devops",
        id: "orders-id",
        name: "orders-api",
        projectPath: "eBankView/orders-api",
        cloneUrl: "https://dev.azure.com/allshareebv/eBankView/_git/orders-api",
        description: null,
        updatedAt: null,
      },
    ]);
  });

  it("paginates before applying a pull request title search", async () => {
    let calls = 0;
    const makePullRequest = (id: number, title: string) => ({
      pullRequestId: id,
      title,
      status: "active",
      sourceRefName: `refs/heads/feature-${id}`,
      targetRefName: "refs/heads/main",
      repository: {
        id: "repo-id",
        name: "paseo",
        project: { id: "project-id", name: "eBankView" },
      },
    });
    const service = createAzureDevOpsService({
      runner: async () => {
        calls += 1;
        const page =
          calls === 1
            ? Array.from({ length: 100 }, (_, index) => makePullRequest(index + 1, "Other"))
            : [makePullRequest(101, "Needle change")];
        return { stdout: JSON.stringify(page), stderr: "" };
      },
      resolveAzPath: async () => "/usr/bin/az",
      resolveRemoteUrl: async () => "https://dev.azure.com/allshareebv/eBankView/_git/paseo",
    });

    await expect(
      service.listPullRequests({ cwd: "/workspace/paseo", query: "needle", limit: 10 }),
    ).resolves.toEqual([expect.objectContaining({ number: 101, title: "Needle change" })]);
    expect(calls).toBe(2);
  });

  it("refuses direct merge until blocking policies pass", async () => {
    const service = createAzureDevOpsService({
      runner: async () => {
        throw new Error("The CLI must not run");
      },
      resolveAzPath: async () => "/usr/bin/az",
    });

    await expect(
      service.mergePullRequest({
        cwd: "/workspace/paseo",
        prNumber: 42,
        mergeMethod: "squash",
        status: currentStatus({ policiesStatus: "pending" }),
      }),
    ).rejects.toThrow("Azure DevOps pull request policies have not passed");
  });

  it.each([
    ["merge", "false"],
    ["squash", "true"],
  ] as const)("completes a pull request using %s", async (mergeMethod, squash) => {
    const calls: string[][] = [];
    const service = createAzureDevOpsService({
      runner: async (args) => {
        calls.push(args);
        return { stdout: "", stderr: "" };
      },
      resolveAzPath: async () => "/usr/bin/az",
      resolveRemoteUrl: async () => "https://dev.azure.com/allshareebv/eBankView/_git/paseo",
    });

    await expect(
      service.mergePullRequest({
        cwd: "/workspace/paseo",
        prNumber: 42,
        mergeMethod,
        status: currentStatus(),
      }),
    ).resolves.toEqual({ success: true });
    expect(calls[0]).toEqual([
      "repos",
      "pr",
      "update",
      "--id",
      "42",
      "--organization",
      "https://dev.azure.com/allshareebv",
      "--status",
      "completed",
      "--squash",
      squash,
      "--output",
      "json",
      "--only-show-errors",
    ]);
  });

  it("enables auto-complete only while the pull request is blocked", async () => {
    const calls: string[][] = [];
    const service = createAzureDevOpsService({
      runner: async (args) => {
        calls.push(args);
        return { stdout: "", stderr: "" };
      },
      resolveAzPath: async () => "/usr/bin/az",
      resolveRemoteUrl: async () => "https://dev.azure.com/allshareebv/eBankView/_git/paseo",
    });

    await expect(
      service.enablePullRequestAutoMerge({
        cwd: "/workspace/paseo",
        prNumber: 42,
        mergeMethod: "squash",
        status: currentStatus({ policiesStatus: "pending" }),
      }),
    ).resolves.toEqual({ success: true });
    expect(calls[0]).toContain("--auto-complete");

    await expect(
      service.enablePullRequestAutoMerge({
        cwd: "/workspace/paseo",
        prNumber: 42,
        mergeMethod: "squash",
        status: currentStatus(),
      }),
    ).rejects.toThrow("already ready for direct merge");
  });

  it("maps Azure DevOps comment threads from the invoke response envelope", async () => {
    const runner: AzureCommandRunner = async (args) => {
      if (args.slice(0, 4).join(" ") === "repos pr show --id") {
        return {
          stdout: JSON.stringify({
            pullRequestId: 42,
            title: "Add Azure DevOps",
            status: "active",
            sourceRefName: "refs/heads/feat/azure-devops",
            targetRefName: "refs/heads/main",
            repository: {
              id: "repo-id",
              name: "paseo",
              project: { id: "project-id", name: "eBankView" },
            },
            _links: {
              web: {
                href: "https://dev.azure.com/allshareebv/eBankView/_git/paseo/pullrequest/42",
              },
            },
          }),
          stderr: "",
        };
      }
      if (args.slice(0, 4).join(" ") === "devops invoke --area git") {
        return {
          stdout: JSON.stringify({
            count: 1,
            value: [
              {
                id: 7,
                status: "active",
                threadContext: {
                  filePath: "/src/main.ts",
                  rightFileStart: { line: 12 },
                  rightFileEnd: { line: 14 },
                },
                comments: [
                  {
                    id: 1,
                    content: "Please cover this branch.",
                    commentType: "text",
                    publishedDate: "2026-09-26T11:00:00Z",
                    author: { displayName: "Reviewer" },
                  },
                ],
              },
            ],
          }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected az command: ${args.join(" ")}`);
    };
    const service = createAzureDevOpsService({
      runner,
      resolveAzPath: async () => "/usr/bin/az",
      resolveRemoteUrl: async () => "https://dev.azure.com/allshareebv/eBankView/_git/paseo",
    });

    const timeline = await service.getPullRequestTimeline({
      cwd: "/workspace/paseo",
      prNumber: 42,
      repoOwner: "eBankView",
      repoName: "paseo",
    });

    expect(timeline.error).toBeNull();
    expect(timeline.items).toEqual([
      {
        kind: "comment",
        id: "7:1",
        author: "Reviewer",
        authorUrl: null,
        avatarUrl: null,
        body: "Please cover this branch.",
        createdAt: Date.parse("2026-09-26T11:00:00Z"),
        url: "https://dev.azure.com/allshareebv/eBankView/_git/paseo/pullrequest/42",
        threadId: "7",
        threadIsResolved: false,
        location: {
          path: "src/main.ts",
          line: 14,
          startLine: 12,
          threadId: "7",
          isResolved: false,
        },
      },
    ]);
  });

  it("treats an empty Azure Boards query as an empty issue list", async () => {
    const service = createAzureDevOpsService({
      runner: async () => ({ stdout: "null", stderr: "" }),
      resolveAzPath: async () => "/usr/bin/az",
      resolveRemoteUrl: async () => "https://dev.azure.com/allshareebv/eBankView/_git/paseo",
    });

    await expect(service.listIssues({ cwd: "/workspace/paseo" })).resolves.toEqual([]);
  });

  it("returns an unavailable search result when Azure CLI is missing", async () => {
    const service = createAzureDevOpsService({
      resolveAzPath: async () => null,
      resolveRemoteUrl: async () => "https://dev.azure.com/allshareebv/eBankView/_git/paseo",
    });

    await expect(
      service.searchIssuesAndPrs({ cwd: "/workspace/paseo", query: "work" }),
    ).resolves.toEqual({
      items: [],
      featuresEnabled: false,
      authState: "cli_missing",
      githubFeaturesEnabled: false,
    });
  });

  it("checks out a cross-repository PR from its source repository instead of the merge ref", async () => {
    const sourceUrl = "https://dev.azure.com/allshareebv/eBankView/_git/paseo-fork";
    const service = createAzureDevOpsService({
      runner: async () => ({
        stdout: JSON.stringify({
          pullRequestId: 42,
          title: "Fork change",
          status: "active",
          sourceRefName: "refs/heads/feat/fork-change",
          targetRefName: "refs/heads/main",
          repository: {
            id: "target-id",
            name: "paseo",
            project: { id: "project-id", name: "eBankView" },
          },
          forkSource: {
            repository: {
              id: "source-id",
              name: "paseo-fork",
              project: { id: "project-id", name: "eBankView" },
              remoteUrl: sourceUrl,
            },
          },
        }),
        stderr: "",
      }),
      resolveAzPath: async () => "/usr/bin/az",
      resolveRemoteUrl: async () => "https://dev.azure.com/allshareebv/eBankView/_git/paseo",
    });

    await expect(
      service.getPullRequestCheckoutTarget({ cwd: "/workspace/paseo", number: 42 }),
    ).resolves.toMatchObject({
      headRefName: "feat/fork-change",
      checkoutRefs: [{ remoteName: sourceUrl, remoteRef: "refs/heads/feat/fork-change" }],
      headRepositoryUrl: sourceUrl,
      isCrossRepository: true,
    });
  });

  it("reports unauthenticated when a workspace has no Azure remote", async () => {
    const service = createAzureDevOpsService({
      resolveAzPath: async () => "/usr/bin/az",
      resolveRemoteUrl: async () => "https://github.com/getpaseo/paseo.git",
    });

    await expect(service.isAuthenticated({ cwd: "/workspace/paseo" })).resolves.toBe(false);
  });
});
