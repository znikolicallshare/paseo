---
title: Workspaces
description: Understand how Paseo groups working directories, agents, terminals, and browsers into workspaces.
nav: Workspaces
order: 10
category: Workspaces
---

# Workspaces

Paseo is organized around workspaces, not chats.

A workspace is the place where a task happens. It has a working directory and can contain multiple sessions running at the same time. In the app, each session opens as a tab.

## Projects contain workspaces

The sidebar starts with projects. A project can be a local directory or a Git repository cloned from GitHub or Azure DevOps on a machine running the Paseo daemon.

Inside each project are workspaces. For example:

```
my-app
├── main
├── fix-login-flow
└── redesign-settings
```

Each workspace is a separate place to work. You can keep one for your main checkout, create another for a feature, or open a pull request as another workspace.

To search and clone Azure DevOps repositories, install Azure CLI with its `azure-devops`
extension, sign in with `az login`, and configure the organization and project used by the picker:

```bash
az extension add --name azure-devops
az login
az devops configure --defaults organization=https://dev.azure.com/example
```

Without a project default, repository search covers every project visible in the organization. Add
`project=Example` to the defaults to limit the picker to one project.

Paseo uses a short-lived token from Azure CLI for HTTPS clones without storing it in Git config.
Configure Git Credential Manager for later HTTPS fetch and push operations, or use SSH with an
authorized key. You can paste a complete Azure Repos HTTPS or SSH URL into the picker without
configuring CLI defaults.

Azure DevOps pull requests support native status, policy summaries, reviews, comments, merge,
squash, and auto-complete. Rebase completion and individual Azure Pipelines job-log drill-down are
not available yet.

Use the [CLI project commands](/docs/cli#projects) to register, list, rename, or delete projects.

## Workspaces contain sessions

Agents run inside a workspace as sessions. A workspace can have one agent session, several agent sessions, terminals, browsers, and diffs open at the same time.

That matters because real development rarely fits into one long chat. You might ask one agent to implement a feature, open a terminal to run a service, start another agent to review the diff, and keep the browser open next to both. Those belong together because they are all part of the same task.

In Paseo, the workspace is the stable container. The sessions are what you run inside it.

## Choose the isolation

Every workspace has an isolation mode:

- **Local** uses an existing directory, such as your main checkout. Use it when sessions should share the files already on disk.
- **Worktree** creates or opens a managed git worktree. Use it when a task needs its own directory and branch.

The workspace is the product concept; a git worktree is one way to isolate its files. More than one workspace can refer to the same managed worktree, and Paseo removes that worktree after its last workspace is archived.

## Creating a workspace

You can create a workspace in the app or from the CLI:

```bash
paseo workspace create --isolation local --path ~/dev/my-app --title main
paseo workspace create --isolation worktree --path ~/dev/my-app --base origin/main
```

You can also create a workspace without starting an agent right away. The workspace is still there with its working directory ready; you can open terminals, run services, or browse files, then start an agent later.

Either way, once the workspace exists you can add more sessions to it. Open a terminal alongside an agent, start a second agent to review changes, or open a browser tab to check a local service. Every session lives as a tab inside the same workspace.

Creating an agent and creating a workspace are separate actions. Pass a workspace ID when you want an agent in a specific existing workspace. A bare `paseo run` from a human shell creates a new local workspace; when one agent runs it, Paseo recognizes the caller and creates a subagent in the caller's workspace.

## Worktrees

Every workspace in Paseo is backed by a working directory. When that directory is a git worktree, you get a separate branch and isolated environment for each task.

If you want the details on configuring setup hooks, scripts, and services, continue to [Git worktrees](/docs/worktrees).
