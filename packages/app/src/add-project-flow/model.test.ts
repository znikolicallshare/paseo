import { describe, expect, it } from "vitest";
import {
  backAddProjectPage,
  chooseAddProjectHost,
  currentAddProjectPage,
  moveAddProjectActiveIndex,
  moveAddProjectSelection,
  openAddProjectFlow,
  openAzureDevOpsLocationPage,
  openDirectorySearchPage,
  openGithubLocationPage,
  openNewDirectoryNamePage,
  openNewDirectoryParentPage,
  setAddProjectActiveIndex,
  setAddProjectPageInput,
  setNewDirectoryName,
  type AddProjectHost,
} from "./model";
import {
  addProjectMethodEmptyText,
  buildAddProjectMethods,
  buildCloneLocationOptions,
  buildManualAzureDevOpsRepositoryChoices,
  buildManualGithubRepositoryChoices,
} from "./options";

const HOST: AddProjectHost = {
  serverId: "host-1",
  label: "Local",
  canAddProject: true,
  canBrowse: true,
  canCloneGithubRepositories: true,
  canSearchGithubRepositories: true,
  canUseForgeRepositories: true,
  canCreateDirectory: true,
};

describe("Add Project navigation", () => {
  it("skips a single connected host without adding it to history", () => {
    const state = openAddProjectFlow({ hosts: [HOST] });

    expect(currentAddProjectPage(state)).toEqual({
      kind: "method",
      hostId: "host-1",
      activeIndex: 0,
      error: null,
      isSubmitting: false,
    });
    expect(backAddProjectPage(state)).toBeNull();
  });

  it("restores page input and selection after Back", () => {
    const secondHost = { ...HOST, serverId: "host-2", label: "Remote" };
    let state = openAddProjectFlow({ hosts: [HOST, secondHost] });
    state = setAddProjectPageInput(state, "rem");
    state = setAddProjectActiveIndex(state, 1);
    state = chooseAddProjectHost(state, secondHost.serverId);
    state = openDirectorySearchPage(state, secondHost.serverId);

    state = backAddProjectPage(state) ?? state;
    state = backAddProjectPage(state) ?? state;

    expect(currentAddProjectPage(state)).toEqual({
      kind: "host",
      query: "rem",
      activeIndex: 1,
      error: null,
    });
  });

  it("wraps keyboard selection in both directions", () => {
    expect(moveAddProjectActiveIndex(2, 3, "next")).toBe(0);
    expect(moveAddProjectActiveIndex(0, 3, "previous")).toBe(2);
    expect(moveAddProjectSelection(0, [true, false, true], "next")).toBe(2);
  });

  it("restores a directory name after returning to and reselecting its parent", () => {
    let state = openAddProjectFlow({ hosts: [HOST] });
    state = openNewDirectoryParentPage(state, HOST.serverId);
    state = openNewDirectoryNamePage(state, HOST.serverId, "~/dev");
    state = setNewDirectoryName(state, "command-center");
    state = backAddProjectPage(state) ?? state;
    state = openNewDirectoryNamePage(state, HOST.serverId, "~/dev");

    expect(currentAddProjectPage(state)).toMatchObject({
      kind: "new-directory-name",
      parentPath: "~/dev",
      name: "command-center",
    });
  });

  it("restores the GitHub destination query and active parent when reopening a repository", () => {
    const repository = {
      id: "repo-1",
      nameWithOwner: "getpaseo/paseo",
      cloneUrl: "git@github.com:getpaseo/paseo.git",
      description: null,
      visibility: "public",
      updatedAt: null,
    };
    let state = openAddProjectFlow({ hosts: [HOST] });
    state = openGithubLocationPage(state, HOST.serverId, repository);
    state = setAddProjectPageInput(state, "~/dev");
    state = setAddProjectActiveIndex(state, 2);
    state = backAddProjectPage(state) ?? state;
    state = openGithubLocationPage(state, HOST.serverId, repository);

    expect(currentAddProjectPage(state)).toMatchObject({
      kind: "github-location",
      query: "~/dev",
      activeIndex: 2,
    });
  });

  it("restores the Azure DevOps destination query and active parent", () => {
    const repository = {
      id: "repo-1",
      name: "paseo",
      projectPath: "Paseo/paseo",
      cloneUrl: "https://dev.azure.com/example/Paseo/_git/paseo",
      description: null,
      updatedAt: null,
    };
    let state = openAddProjectFlow({ hosts: [HOST] });
    state = openAzureDevOpsLocationPage(state, HOST.serverId, repository);
    state = setAddProjectPageInput(state, "~/src");
    state = setAddProjectActiveIndex(state, 1);
    state = backAddProjectPage(state) ?? state;
    state = openAzureDevOpsLocationPage(state, HOST.serverId, repository);

    expect(currentAddProjectPage(state)).toMatchObject({
      kind: "azure-devops-location",
      query: "~/src",
      activeIndex: 1,
    });
  });
});

describe("Add Project options", () => {
  it("hides every mutating method when the host lacks stable project identity", () => {
    const outdatedHost = { ...HOST, canAddProject: false };

    expect(buildAddProjectMethods(outdatedHost)).toEqual([]);
    expect(addProjectMethodEmptyText(outdatedHost)).toBe("Update the host to use Add Project.");
  });

  it("keeps host-upgrade methods discoverable while hiding local-only Browse", () => {
    expect(
      buildAddProjectMethods({
        ...HOST,
        canBrowse: false,
        canCloneGithubRepositories: false,
        canSearchGithubRepositories: false,
        canUseForgeRepositories: false,
        canCreateDirectory: false,
      }),
    ).toEqual([
      {
        id: "directory-search",
        label: "Search for directory",
        description: "Find a directory on Local",
      },
      {
        id: "github",
        label: "Clone from GitHub",
        description: "Update this host to clone GitHub repositories",
        disabled: true,
      },
      {
        id: "new-directory",
        label: "New directory",
        description: "Update this host to create directories",
        disabled: true,
      },
    ]);
  });

  it("shows Azure DevOps only when neutral forge repositories are supported", () => {
    expect(buildAddProjectMethods(HOST)).toContainEqual({
      id: "azure-devops",
      label: "Clone from Azure DevOps",
      description: "Search repositories in your configured Azure DevOps project",
    });
    expect(
      buildAddProjectMethods({ ...HOST, canUseForgeRepositories: false }).some(
        (method) => method.id === "azure-devops",
      ),
    ).toBe(false);
  });

  it("offers manual URL and protocol-specific owner/repo clone choices", () => {
    expect(buildManualGithubRepositoryChoices("git@github.com:getpaseo/paseo.git")).toEqual([
      expect.objectContaining({
        id: "manual:git@github.com:getpaseo/paseo.git",
        nameWithOwner: "getpaseo/paseo",
        cloneUrl: "git@github.com:getpaseo/paseo.git",
      }),
    ]);
    expect(buildManualGithubRepositoryChoices("getpaseo/paseo")).toEqual([
      expect.objectContaining({ cloneProtocol: "https", cloneUrl: "getpaseo/paseo" }),
      expect.objectContaining({ cloneProtocol: "ssh", cloneUrl: "getpaseo/paseo" }),
    ]);
    expect(buildManualGithubRepositoryChoices("paseo")).toEqual([]);
  });

  it("offers complete Azure Repos URLs as manual clone choices", () => {
    const cloneUrl = "https://dev.azure.com/allshareebv/eBankView/_git/orders-api";
    expect(buildManualAzureDevOpsRepositoryChoices(cloneUrl)).toEqual([
      {
        id: `manual:${cloneUrl}`,
        name: "orders-api",
        projectPath: "allshareebv/eBankView/_git/orders-api",
        cloneUrl,
        description: "Clone this repository URL",
        updatedAt: null,
      },
    ]);
    expect(
      buildManualAzureDevOpsRepositoryChoices(
        "git@ssh.dev.azure.com:v3/allshareebv/eBankView/orders-api",
      ),
    ).toHaveLength(1);
    expect(buildManualAzureDevOpsRepositoryChoices("getpaseo/paseo")).toEqual([]);
    expect(buildManualAzureDevOpsRepositoryChoices("https://github.com/getpaseo/paseo")).toEqual(
      [],
    );
  });

  it("shows final clone paths while retaining parent paths as values", () => {
    expect(
      buildCloneLocationOptions({
        parents: ["~/dev", "~/workspace"],
        repositoryName: "paseo",
        existingPaths: ["~/workspace/paseo"],
      }),
    ).toEqual([
      {
        id: "~/dev",
        path: "~/dev",
        displayPath: "~/dev/paseo",
        secondaryText: "Parent directory: ~/dev",
        disabled: false,
      },
      {
        id: "~/workspace",
        path: "~/workspace",
        displayPath: "~/workspace/paseo",
        secondaryText: "Already exists",
        disabled: true,
      },
    ]);
  });

  it("shows equivalent absolute-home and tilde destinations only once", () => {
    expect(
      buildCloneLocationOptions({
        parents: ["/Users/moboudra/dev", "~/dev"],
        repositoryName: "dotfiles",
        existingPaths: [],
      }),
    ).toEqual([
      {
        id: "/Users/moboudra/dev",
        path: "/Users/moboudra/dev",
        displayPath: "/Users/moboudra/dev/dotfiles",
        secondaryText: "Parent directory: /Users/moboudra/dev",
        disabled: false,
      },
    ]);
  });
});
