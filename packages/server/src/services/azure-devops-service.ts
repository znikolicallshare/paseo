import { z } from "zod";
import { parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import { CHECK_TRAIT_WARNING } from "@getpaseo/protocol/check-traits";
import { findExecutable } from "../executable-resolution/executable-resolution.js";
import { runGitCommand, type RunGitCommand } from "../utils/run-git-command.js";
import {
  createCachedCliPathResolver,
  createForgeCliRunner,
  defaultResolveRemoteUrl,
  ForgeAuthenticationError,
  ForgeCliMissingError,
  ForgeCommandError,
  normalizeCliCommandError,
  parseCliJsonOutput,
  type ForgeCommandFailureParams,
} from "./forge-cli-command.js";
import {
  compareTimelineItems,
  computeChecksStatus,
  createUnavailableSearchResult,
  normalizeForgeSearchKinds,
  parseOptionalTime,
  type CheckDetails,
  type CreatePullRequestOptions,
  type CurrentPullRequestStatus,
  type DisablePullRequestAutoMergeOptions,
  type EnablePullRequestAutoMergeOptions,
  type ForgeReadOptions,
  type ForgeRepositorySummary,
  type GitAuthenticationOptions,
  type GetGitCloneAuthorizationHeaderOptions,
  type ForgeService,
  type GetCheckDetailsOptions,
  type GetPullRequestOptions,
  type GetPullRequestTimelineOptions,
  type IssueSummary,
  type ListIssuesOptions,
  type ListPullRequestsOptions,
  type MergePullRequestOptions,
  type PullRequestAutoMergeResult,
  type PullRequestCheck,
  type PullRequestCheckoutTarget,
  type PullRequestCreateResult,
  type PullRequestMergeResult,
  type PullRequestSummary,
  type PullRequestTimeline,
  type PullRequestTimelineError,
  type PullRequestTimelineItem,
  type SearchIssuesAndPrsOptions,
  type SearchForgeRepositoriesOptions,
  type SearchResult,
} from "./forge-service.js";
import {
  isAzureDevOpsStatusFacts,
  type AzureDevOpsForgeSpecificStatusFacts,
} from "./azure-devops-facts.js";

const AZURE_DEVOPS_ENV = {
  AZURE_CORE_ONLY_SHOW_ERRORS: "1",
  AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no",
  GIT_TERMINAL_PROMPT: "0",
} as const;

const AZURE_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_LIST_LIMIT = 100;
const PULL_REQUEST_PAGE_SIZE = 100;
const PULL_REQUEST_PAGE_LIMIT = 10;
const AZURE_DEVOPS_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";
const AZURE_DEVOPS_GIT_CREDENTIAL_HELPER = String.raw`!f() { [ "$1" = get ] || exit 0; token="$(az account get-access-token --resource ${AZURE_DEVOPS_RESOURCE_ID} --query accessToken --output tsv --only-show-errors)" || { echo 'Azure DevOps authentication expired; run az login.' >&2; exit 1; }; [ -n "$token" ] || exit 1; printf 'username=AzureDevOps\npassword=%s\n\n' "$token"; }; f`;
const AZURE_DEVOPS_HOSTS = new Set([
  "dev.azure.com",
  "ssh.dev.azure.com",
  "vs-ssh.visualstudio.com",
]);

export interface AzureDevOpsRemoteIdentity {
  organization: string;
  organizationUrl: string;
  project: string;
  repository: string;
}

export interface AzureCommandRunnerOptions {
  cwd: string;
  envOverlay?: Record<string, string>;
}

export interface AzureCommandResult {
  stdout: string;
  stderr: string;
}

export type AzureCommandRunner = (
  args: string[],
  options: AzureCommandRunnerOptions,
) => Promise<AzureCommandResult>;

export interface CreateAzureDevOpsServiceOptions {
  runner?: AzureCommandRunner;
  resolveAzPath?: () => Promise<string | null>;
  resolveRemoteUrl?: (cwd: string) => Promise<string | null>;
  resolveContributorName?: (cwd: string) => Promise<string | null>;
  gitRunner?: RunGitCommand;
}

export class AzureCliMissingError extends ForgeCliMissingError {
  constructor() {
    super("Azure CLI (az) with the azure-devops extension is not installed or not in PATH");
    this.name = "AzureCliMissingError";
  }
}

export class AzureDevOpsAuthenticationError extends ForgeAuthenticationError {
  constructor(params: { stderr: string }) {
    super("Azure DevOps CLI authentication failed", params);
    this.name = "AzureDevOpsAuthenticationError";
  }
}

export class AzureDevOpsCommandError extends ForgeCommandError {
  constructor(params: ForgeCommandFailureParams) {
    super({ brand: "Azure DevOps", binary: "az" }, params);
    this.name = "AzureDevOpsCommandError";
  }
}

const AzureRepositoryProjectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .passthrough();

const AzureRepositorySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    project: AzureRepositoryProjectSchema,
    remoteUrl: z.string().nullish(),
    sshUrl: z.string().nullish(),
    webUrl: z.string().nullish(),
    defaultBranch: z.string().nullish(),
    isDisabled: z.boolean().optional().default(false),
  })
  .passthrough();

const AzureReviewerSchema = z
  .object({
    id: z.string().optional(),
    displayName: z.string().optional(),
    uniqueName: z.string().optional(),
    imageUrl: z.string().nullable().optional(),
    vote: z.number().optional().default(0),
    isRequired: z.boolean().optional().default(false),
  })
  .passthrough();

const AzurePullRequestSchema = z
  .object({
    pullRequestId: z.number().int().positive(),
    title: z.string(),
    description: z.string().nullable().optional(),
    status: z.string(),
    mergeStatus: z.string().optional().default("unknown"),
    isDraft: z.boolean().optional().default(false),
    sourceRefName: z.string(),
    targetRefName: z.string(),
    creationDate: z.string().optional(),
    autoCompleteSetBy: z.unknown().nullable().optional(),
    labels: z.array(z.object({ name: z.string() }).passthrough()).nullish(),
    reviewers: z.array(AzureReviewerSchema).optional().default([]),
    repository: AzureRepositorySchema,
    forkSource: z
      .object({ repository: AzureRepositorySchema.optional() })
      .passthrough()
      .nullable()
      .optional(),
    lastMergeSourceCommit: z.object({ commitId: z.string() }).passthrough().optional(),
    _links: z
      .object({ web: z.object({ href: z.string() }).passthrough().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const AzurePolicySchema = z
  .object({
    evaluationId: z.union([z.string(), z.number()]).optional(),
    status: z.string(),
    configuration: z
      .object({
        isBlocking: z.boolean().optional(),
        type: z.object({ displayName: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const AzureThreadContextSchema = z
  .object({
    filePath: z.string().optional(),
    rightFileStart: z.object({ line: z.number().optional() }).passthrough().optional(),
    rightFileEnd: z.object({ line: z.number().optional() }).passthrough().optional(),
  })
  .passthrough();

const AzureCommentSchema = z
  .object({
    id: z.number(),
    parentCommentId: z.number().optional(),
    content: z.string().optional(),
    commentType: z.string().optional(),
    isDeleted: z.boolean().optional(),
    publishedDate: z.string().optional(),
    author: z
      .object({
        displayName: z.string().optional(),
        uniqueName: z.string().optional(),
        imageUrl: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const AzureThreadSchema = z
  .object({
    id: z.number(),
    status: z.union([z.string(), z.number()]).optional(),
    isDeleted: z.boolean().optional(),
    threadContext: AzureThreadContextSchema.nullable().optional(),
    comments: z.array(AzureCommentSchema).optional().default([]),
  })
  .passthrough();

const AzureThreadListSchema = z.union([
  z.array(AzureThreadSchema),
  z.object({ value: z.array(AzureThreadSchema) }).passthrough(),
]);

const AzureWorkItemSchema = z
  .object({
    id: z.number().int().positive(),
    url: z.string().optional(),
    fields: z.record(z.string(), z.unknown()),
    _links: z
      .object({ html: z.object({ href: z.string() }).passthrough().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const AzureWorkItemListSchema = z.array(AzureWorkItemSchema).nullable();

type AzurePullRequest = z.infer<typeof AzurePullRequestSchema>;
type AzurePolicy = z.infer<typeof AzurePolicySchema>;
type AzureThread = z.infer<typeof AzureThreadSchema>;
type AzureComment = z.infer<typeof AzureCommentSchema>;
type AzureWorkItem = z.infer<typeof AzureWorkItemSchema>;

async function resolveAzPath(): Promise<string | null> {
  return findExecutable("az");
}

const azureCliRunner = createForgeCliRunner({
  binary: "az",
  envOverlay: AZURE_DEVOPS_ENV,
  timeoutMs: AZURE_COMMAND_TIMEOUT_MS,
  isAuthFailureText,
  errorClasses: {
    isAlreadyClassified: (error) =>
      error instanceof AzureDevOpsAuthenticationError || error instanceof AzureCliMissingError,
    isCommandError: (error): error is AzureDevOpsCommandError =>
      error instanceof AzureDevOpsCommandError,
    createAuthError: (stderr) => new AzureDevOpsAuthenticationError({ stderr }),
    createMissingError: () => new AzureCliMissingError(),
    createCommandError: (params) => new AzureDevOpsCommandError(params),
  },
});

async function runAzureCommand(
  args: string[],
  options: AzureCommandRunnerOptions,
): Promise<AzureCommandResult> {
  return azureCliRunner.run(args, options);
}

export function isAzureDevOpsHost(host: string): boolean {
  return (
    AZURE_DEVOPS_HOSTS.has(host) ||
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.visualstudio\.com$/u.test(host)
  );
}

export function parseAzureDevOpsRemoteIdentity(
  remoteUrl: string,
): AzureDevOpsRemoteIdentity | null {
  const location = parseGitRemoteLocation(remoteUrl);
  if (!location || !isAzureDevOpsHost(location.host)) {
    return null;
  }

  const segments = location.path.split("/").filter(Boolean);
  let organization: string | undefined;
  let project: string | undefined;
  let repository: string | undefined;

  if (location.host === "dev.azure.com") {
    [organization, project, , repository] = segments;
    if (segments[2]?.toLowerCase() !== "_git" || segments.length !== 4) return null;
  } else if (location.host === "ssh.dev.azure.com" || location.host === "vs-ssh.visualstudio.com") {
    [, organization, project, repository] = segments;
    if (segments[0]?.toLowerCase() !== "v3" || segments.length !== 4) return null;
  } else {
    organization = location.host.slice(0, -".visualstudio.com".length);
    const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === "_git");
    if (gitIndex < 1 || gitIndex !== segments.length - 2) return null;
    project = segments[gitIndex - 1];
    repository = segments[gitIndex + 1];
  }

  if (!organization || !project || !repository) return null;
  return {
    organization,
    organizationUrl: `https://dev.azure.com/${organization}`,
    project,
    repository,
  };
}

function isAuthFailureText(text: string): boolean {
  return /(?:az login|az devops login|not authenticated|authentication failed|unauthorized|TF400813|401|403)/iu.test(
    text,
  );
}

function isExtensionMissingText(text: string): boolean {
  return /(?:azure-devops extension|extension add --name azure-devops|['"](?:repos|boards|devops)['"] is misspelled or not recognized)/iu.test(
    text,
  );
}

function isAzureSearchAuthFailure(error: unknown): boolean {
  return error instanceof AzureCliMissingError || error instanceof AzureDevOpsAuthenticationError;
}

function stripHeadPrefix(ref: string): string {
  return ref.replace(/^refs\/heads\//u, "");
}

function mapPullRequestState(status: string): string {
  if (status === "active") return "open";
  return status === "completed" ? "merged" : "closed";
}

function pullRequestUrl(pr: AzurePullRequest, identity: AzureDevOpsRemoteIdentity): string {
  return (
    pr._links?.web?.href ??
    `${identity.organizationUrl}/${encodeURIComponent(identity.project)}/_git/${encodeURIComponent(identity.repository)}/pullrequest/${pr.pullRequestId}`
  );
}

function projectPath(pr: AzurePullRequest): string {
  return `${pr.repository.project.name}/${pr.repository.name}`;
}

function toPullRequestSummary(
  pr: AzurePullRequest,
  identity: AzureDevOpsRemoteIdentity,
): PullRequestSummary {
  return {
    number: pr.pullRequestId,
    title: pr.title,
    url: pullRequestUrl(pr, identity),
    state: mapPullRequestState(pr.status),
    body: pr.description ?? null,
    projectPath: projectPath(pr),
    baseRefName: stripHeadPrefix(pr.targetRefName),
    headRefName: stripHeadPrefix(pr.sourceRefName),
    labels: (pr.labels ?? []).map((label) => label.name),
    updatedAt: pr.creationDate ?? "",
  };
}

function toRepositorySummary(
  repository: z.infer<typeof AzureRepositorySchema>,
): ForgeRepositorySummary {
  const cloneUrl = repository.remoteUrl ?? repository.sshUrl;
  if (!cloneUrl) {
    throw new Error(`Azure DevOps repository ${repository.name} has no clone URL`);
  }
  return {
    forge: "azure-devops",
    id: repository.id,
    name: repository.name,
    projectPath: `${repository.project.name}/${repository.name}`,
    cloneUrl,
    description: null,
    updatedAt: null,
  };
}

function mapPolicyStatus(status: string): PullRequestCheck["status"] {
  switch (status.toLowerCase()) {
    case "approved":
    case "notapplicable":
      return "success";
    case "rejected":
    case "broken":
      return "failure";
    case "canceled":
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

function mapMergeStatus(status: string): CurrentPullRequestStatus["mergeable"] {
  if (status === "succeeded") return "MERGEABLE";
  if (status === "conflicts") return "CONFLICTING";
  return "UNKNOWN";
}

function toPolicyCheck(policy: AzurePolicy, prUrl: string, index: number): PullRequestCheck {
  const status = mapPolicyStatus(policy.status);
  return {
    name: policy.configuration?.type?.displayName ?? `Policy ${index + 1}`,
    status: status === "failure" && policy.configuration?.isBlocking === false ? "success" : status,
    url: prUrl,
    ...(status === "failure" && policy.configuration?.isBlocking === false
      ? { traits: [CHECK_TRAIT_WARNING] }
      : {}),
  };
}

function reviewDecision(pr: AzurePullRequest): CurrentPullRequestStatus["reviewDecision"] {
  const required = pr.reviewers.filter((reviewer) => reviewer.isRequired);
  const considered = required.length > 0 ? required : pr.reviewers;
  if (considered.some((reviewer) => reviewer.vote < 0)) return "changes_requested";
  if (considered.length > 0 && considered.every((reviewer) => reviewer.vote > 0)) return "approved";
  return "pending";
}

function toCurrentPullRequestStatus(
  pr: AzurePullRequest,
  identity: AzureDevOpsRemoteIdentity,
  policies: AzurePolicy[],
): CurrentPullRequestStatus {
  const url = pullRequestUrl(pr, identity);
  const checks = policies.map((policy, index) => toPolicyCheck(policy, url, index));
  const checksStatus = computeChecksStatus(checks);
  const blockingChecks = policies
    .filter((policy) => policy.configuration?.isBlocking !== false)
    .map((policy, index) => toPolicyCheck(policy, url, index));
  const forgeSpecific: AzureDevOpsForgeSpecificStatusFacts = {
    forge: "azure-devops",
    mergeStatus: pr.mergeStatus,
    autoCompleteEnabled: pr.autoCompleteSetBy != null,
    policiesStatus: computeChecksStatus(blockingChecks),
  };
  return {
    number: pr.pullRequestId,
    repoOwner: pr.repository.project.name,
    repoName: pr.repository.name,
    projectPath: projectPath(pr),
    url,
    title: pr.title,
    state: mapPullRequestState(pr.status),
    baseRefName: stripHeadPrefix(pr.targetRefName),
    headRefName: stripHeadPrefix(pr.sourceRefName),
    isMerged: pr.status === "completed",
    isDraft: pr.isDraft,
    mergeable: mapMergeStatus(pr.mergeStatus),
    checks,
    checksStatus,
    reviewDecision: reviewDecision(pr),
    forgeSpecific,
  };
}

function azureContextArgs(identity: AzureDevOpsRemoteIdentity): string[] {
  return [
    "--organization",
    identity.organizationUrl,
    "--project",
    identity.project,
    "--repository",
    identity.repository,
  ];
}

function outputArgs(): string[] {
  return ["--output", "json", "--only-show-errors"];
}

function isTerminalPullRequest(pr: AzurePullRequest): boolean {
  return pr.status !== "active";
}

function chooseCurrentPullRequest(
  prs: AzurePullRequest[],
  identity: AzureDevOpsRemoteIdentity,
  headRef: string,
  headSha?: string,
): AzurePullRequest | null {
  const candidates = prs.filter((pr) => {
    const sourceRepository = pr.forkSource?.repository ?? pr.repository;
    return (
      stripHeadPrefix(pr.sourceRefName) === headRef &&
      sourceRepository.name.toLowerCase() === identity.repository.toLowerCase() &&
      sourceRepository.project.name.toLowerCase() === identity.project.toLowerCase()
    );
  });
  return (
    candidates.find((pr) => pr.status === "active") ??
    candidates.find(
      (pr) =>
        isTerminalPullRequest(pr) &&
        headSha !== undefined &&
        pr.lastMergeSourceCommit?.commitId === headSha,
    ) ??
    null
  );
}

function buildCheckoutTarget(
  pr: AzurePullRequest,
  originUrl: string | null,
): PullRequestCheckoutTarget {
  const sourceRepository = pr.forkSource?.repository;
  const isCrossRepository = Boolean(sourceRepository && sourceRepository.id !== pr.repository.id);
  const checkoutRefs = buildAzureCheckoutRefs({
    sourceRefName: pr.sourceRefName,
    sourceRepository,
    isCrossRepository,
    originUrl,
  });
  return {
    number: pr.pullRequestId,
    baseRefName: stripHeadPrefix(pr.targetRefName),
    headRefName: stripHeadPrefix(pr.sourceRefName),
    ...(checkoutRefs ? { checkoutRefs } : {}),
    headOwnerLogin: sourceRepository?.project.name ?? null,
    headRepositorySshUrl: sourceRepository?.sshUrl ?? null,
    headRepositoryUrl: sourceRepository?.remoteUrl ?? null,
    isCrossRepository,
  };
}

function buildAzureCheckoutRefs(input: {
  sourceRefName: string;
  sourceRepository: z.infer<typeof AzureRepositorySchema> | undefined;
  isCrossRepository: boolean;
  originUrl: string | null;
}): PullRequestCheckoutTarget["checkoutRefs"] {
  if (!input.isCrossRepository) {
    return [{ remoteName: "origin", remoteRef: input.sourceRefName }];
  }
  const originTransport = input.originUrl
    ? parseGitRemoteLocation(input.originUrl)?.transport
    : undefined;
  const sourceRemoteUrl =
    originTransport === "ssh" || originTransport === "scp"
      ? (input.sourceRepository?.sshUrl ?? input.sourceRepository?.remoteUrl)
      : (input.sourceRepository?.remoteUrl ?? input.sourceRepository?.sshUrl);
  return sourceRemoteUrl
    ? [{ remoteName: sourceRemoteUrl, remoteRef: input.sourceRefName }]
    : undefined;
}

function assertSafeQuery(query: string): string {
  return query.replaceAll("'", "''");
}

function workItemField(item: AzureWorkItem, name: string): string | null {
  const value = item.fields[name];
  return typeof value === "string" ? value : null;
}

function toIssueSummary(item: AzureWorkItem, identity: AzureDevOpsRemoteIdentity): IssueSummary {
  const tags = workItemField(item, "System.Tags");
  return {
    number: item.id,
    title: workItemField(item, "System.Title") ?? `Work item ${item.id}`,
    url:
      item._links?.html?.href ??
      `${identity.organizationUrl}/${encodeURIComponent(identity.project)}/_workitems/edit/${item.id}`,
    state: workItemField(item, "System.State") ?? "unknown",
    body: workItemField(item, "System.Description"),
    projectPath: identity.project,
    labels: tags
      ? tags
          .split(";")
          .map((tag) => tag.trim())
          .filter(Boolean)
      : [],
    updatedAt: workItemField(item, "System.ChangedDate") ?? "",
  };
}

function toIssueSearchItem(
  item: AzureWorkItem,
  identity: AzureDevOpsRemoteIdentity,
): SearchResult["items"][number] {
  const issue = toIssueSummary(item, identity);
  return Object.assign(issue, {
    kind: "issue" as const,
    baseRefName: null,
    headRefName: null,
  });
}

function toPullRequestSearchItem(
  pr: AzurePullRequest,
  identity: AzureDevOpsRemoteIdentity,
): SearchResult["items"][number] {
  return Object.assign(toPullRequestSummary(pr, identity), {
    kind: "change_request" as const,
  });
}

function isResolvedThread(status: string | number | undefined): boolean {
  return (
    status === "fixed" ||
    status === "wontFix" ||
    status === "closed" ||
    status === "byDesign" ||
    status === 2 ||
    status === 3 ||
    status === 4 ||
    status === 5
  );
}

function toTimelineError(error: unknown): PullRequestTimelineError {
  if (error instanceof AzureDevOpsAuthenticationError) {
    return { kind: "forbidden", message: error.message };
  }
  const detail = error instanceof AzureDevOpsCommandError ? error.stderr : "";
  if (/\b(?:404|not found|does not exist)\b/iu.test(detail)) {
    return { kind: "not_found", message: detail.trim() };
  }
  return {
    kind: "unknown",
    message: error instanceof Error ? error.message : String(error),
  };
}

function toTimelineComment(
  thread: AzureThread,
  comment: AzureComment,
  prUrl: string,
): PullRequestTimelineItem | null {
  if (
    thread.isDeleted ||
    comment.isDeleted ||
    comment.commentType === "system" ||
    !comment.content
  ) {
    return null;
  }
  const context = thread.threadContext;
  return {
    kind: "comment",
    id: `${thread.id}:${comment.id}`,
    author: comment.author?.displayName ?? comment.author?.uniqueName ?? "Unknown",
    authorUrl: comment.author?.url ?? null,
    avatarUrl: comment.author?.imageUrl ?? null,
    body: comment.content,
    createdAt: parseOptionalTime(comment.publishedDate),
    url: prUrl,
    threadId: String(thread.id),
    threadIsResolved: isResolvedThread(thread.status),
    ...(context?.filePath
      ? {
          location: {
            path: context.filePath.replace(/^\//u, ""),
            ...(context.rightFileStart?.line
              ? { line: context.rightFileStart.line, startLine: context.rightFileStart.line }
              : {}),
            ...(context.rightFileEnd?.line ? { line: context.rightFileEnd.line } : {}),
            threadId: String(thread.id),
            isResolved: isResolvedThread(thread.status),
          },
        }
      : {}),
  };
}

function unwrapThreads(value: z.infer<typeof AzureThreadListSchema>): AzureThread[] {
  return Array.isArray(value) ? value : value.value;
}

function formatPullRequestDescription(body: string | undefined, contributorName: string): string {
  const normalizedBody =
    body?.includes("\\n") && !body.includes("\n") ? body.replaceAll("\\n", "\n") : (body ?? "");
  const attribution = `__Contributed on behalf of ${contributorName.trim()}__`;
  return normalizedBody.trim() ? `${normalizedBody.trim()}\n\n${attribution}` : attribution;
}

async function resolveGitContributorName(cwd: string): Promise<string | null> {
  const result = await runGitCommand(["config", "user.name"], {
    cwd,
    acceptExitCodes: [0, 1],
  });
  return result.stdout.trim() || null;
}

export function createAzureDevOpsService(
  options: CreateAzureDevOpsServiceOptions = {},
): ForgeService {
  const runner = options.runner ?? runAzureCommand;
  const resolveAz = createCachedCliPathResolver(options.resolveAzPath ?? resolveAzPath);
  const resolveRemoteUrl = options.resolveRemoteUrl ?? defaultResolveRemoteUrl;
  const resolveContributorName = options.resolveContributorName ?? resolveGitContributorName;
  const gitRunner = options.gitRunner ?? runGitCommand;

  async function run(args: string[], runOptions: AzureCommandRunnerOptions): Promise<string> {
    const azPath = await resolveAz();
    if (!azPath) throw new AzureCliMissingError();
    try {
      const response = await runner(args, runOptions);
      return response.stdout.trim();
    } catch (error) {
      const normalized = normalizeCliCommandError({
        error,
        args,
        cwd: runOptions.cwd,
        commandName: "az",
        timeoutMs: AZURE_COMMAND_TIMEOUT_MS,
        isAlreadyClassified: (candidate) =>
          candidate instanceof AzureDevOpsAuthenticationError ||
          candidate instanceof AzureCliMissingError,
        isCommandError: (candidate): candidate is AzureDevOpsCommandError =>
          candidate instanceof AzureDevOpsCommandError,
        isAuthFailureText,
        createAuthError: (stderr) => new AzureDevOpsAuthenticationError({ stderr }),
        createMissingError: () => new AzureCliMissingError(),
        createCommandError: (params) => new AzureDevOpsCommandError(params),
      });
      if (
        normalized instanceof AzureDevOpsCommandError &&
        isExtensionMissingText(normalized.stderr)
      ) {
        throw new AzureCliMissingError();
      }
      throw normalized;
    }
  }

  async function runJson<T>(
    args: string[],
    runOptions: AzureCommandRunnerOptions,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const stdout = await run(args, runOptions);
    return parseCliJsonOutput({
      commandName: "az",
      args,
      cwd: runOptions.cwd,
      stdout,
      schema,
      createCommandError: (params) => new AzureDevOpsCommandError(params),
    });
  }

  async function resolveIdentity(cwd: string): Promise<AzureDevOpsRemoteIdentity> {
    const remoteUrl = await resolveRemoteUrl(cwd);
    const identity = remoteUrl ? parseAzureDevOpsRemoteIdentity(remoteUrl) : null;
    if (!identity) throw new Error("Unable to resolve Azure DevOps repository from origin remote");
    return identity;
  }

  async function listPullRequests(params: {
    input: ListPullRequestsOptions;
    sourceBranch?: string;
    repositoryScoped?: boolean;
    collectAll?: boolean;
  }): Promise<AzurePullRequest[]> {
    const { input, sourceBranch, repositoryScoped = true, collectAll = false } = params;
    const identity = await resolveIdentity(input.cwd);
    const query = input.query?.trim().toLowerCase();
    const requestedLimit = input.limit ?? DEFAULT_LIST_LIMIT;
    const pageSize = query || collectAll ? PULL_REQUEST_PAGE_SIZE : requestedLimit;
    const matches: AzurePullRequest[] = [];
    for (let page = 0; page < PULL_REQUEST_PAGE_LIMIT; page += 1) {
      const args = [
        "repos",
        "pr",
        "list",
        "--organization",
        identity.organizationUrl,
        "--project",
        identity.project,
      ];
      if (repositoryScoped) args.push("--repository", identity.repository);
      args.push("--status", "all");
      if (sourceBranch) args.push("--source-branch", sourceBranch);
      args.push("--top", String(pageSize));
      if (page > 0) args.push("--skip", String(page * pageSize));
      args.push(...outputArgs());
      const pullRequests = await runJson(args, { cwd: input.cwd }, z.array(AzurePullRequestSchema));
      const filtered = query
        ? pullRequests.filter(
            (pr) =>
              pr.title.toLowerCase().includes(query) ||
              (pr.description ?? "").toLowerCase().includes(query),
          )
        : pullRequests;
      matches.push(...filtered);
      if (!collectAll && matches.length >= requestedLimit) break;
      if (pullRequests.length < pageSize) break;
    }
    return collectAll ? matches : matches.slice(0, requestedLimit);
  }

  async function viewPullRequest(cwd: string, number: number): Promise<AzurePullRequest> {
    const identity = await resolveIdentity(cwd);
    return runJson(
      [
        "repos",
        "pr",
        "show",
        "--id",
        String(number),
        "--organization",
        identity.organizationUrl,
        ...outputArgs(),
      ],
      { cwd },
      AzurePullRequestSchema,
    );
  }

  async function listPolicies(cwd: string, pr: AzurePullRequest): Promise<AzurePolicy[]> {
    const identity = await resolveIdentity(cwd);
    return runJson(
      [
        "repos",
        "pr",
        "policy",
        "list",
        "--id",
        String(pr.pullRequestId),
        "--organization",
        identity.organizationUrl,
        ...outputArgs(),
      ],
      { cwd },
      z.array(AzurePolicySchema),
    );
  }

  async function listIssues(input: ListIssuesOptions): Promise<AzureWorkItem[]> {
    const identity = await resolveIdentity(input.cwd);
    const query = input.query?.trim();
    const titleFilter = query ? ` AND [System.Title] CONTAINS '${assertSafeQuery(query)}'` : "";
    const wiql =
      `SELECT [System.Id], [System.Title], [System.State], [System.Description], ` +
      `[System.Tags], [System.ChangedDate] FROM WorkItems WHERE ` +
      `[System.TeamProject] = '${assertSafeQuery(identity.project)}'${titleFilter} ` +
      `ORDER BY [System.ChangedDate] DESC`;
    const items = await runJson(
      [
        "boards",
        "query",
        "--organization",
        identity.organizationUrl,
        "--project",
        identity.project,
        "--wiql",
        wiql,
        ...outputArgs(),
      ],
      { cwd: input.cwd },
      AzureWorkItemListSchema,
    );
    return (items ?? []).slice(0, input.limit ?? DEFAULT_LIST_LIMIT);
  }

  return {
    async configureGitAuthentication(input: GitAuthenticationOptions): Promise<void> {
      const location = parseGitRemoteLocation(input.remoteUrl);
      if (!location || location.transport !== "https" || !isAzureDevOpsHost(location.host)) return;
      if (!(await resolveAz())) return;
      await gitRunner(
        [
          "config",
          "--local",
          "--replace-all",
          `credential.https://${location.host}.helper`,
          AZURE_DEVOPS_GIT_CREDENTIAL_HELPER,
        ],
        { cwd: input.cwd },
      );
    },

    async getGitCloneAuthorizationHeader(
      input: GetGitCloneAuthorizationHeaderOptions,
    ): Promise<string | null> {
      if (parseGitRemoteLocation(input.cloneUrl)?.transport !== "https") return null;
      const accessToken = await run(
        [
          "account",
          "get-access-token",
          "--resource",
          AZURE_DEVOPS_RESOURCE_ID,
          "--query",
          "accessToken",
          "--output",
          "tsv",
        ],
        { cwd: input.cwd },
      );
      if (!accessToken) throw new AzureDevOpsAuthenticationError({ stderr: "Empty access token" });
      return `AUTHORIZATION: bearer ${accessToken}`;
    },

    async searchForgeRepositories(
      input: SearchForgeRepositoriesOptions,
    ): Promise<ForgeRepositorySummary[]> {
      const repositories = await runJson(
        ["repos", "list", ...outputArgs()],
        { cwd: input.cwd },
        z.array(AzureRepositorySchema),
      );
      const query = input.query.trim().toLowerCase();
      return repositories
        .filter((repository) => !repository.isDisabled)
        .map(toRepositorySummary)
        .filter(
          (repository) =>
            !query ||
            repository.name.toLowerCase().includes(query) ||
            repository.projectPath.toLowerCase().includes(query),
        )
        .slice(0, input.limit ?? DEFAULT_LIST_LIMIT);
    },

    async isAuthenticated(input: { cwd: string } & ForgeReadOptions): Promise<boolean> {
      try {
        if (!(await resolveAz())) return false;
        const identity = await resolveIdentity(input.cwd);
        await runner(
          [
            "devops",
            "project",
            "show",
            "--organization",
            identity.organizationUrl,
            "--project",
            identity.project,
            ...outputArgs(),
          ],
          { cwd: input.cwd },
        );
        return true;
      } catch {
        return false;
      }
    },

    async getCurrentPullRequestStatus(input): Promise<CurrentPullRequestStatus | null> {
      const identity = await resolveIdentity(input.cwd);
      const prs = await listPullRequests({
        input: { cwd: input.cwd },
        sourceBranch: input.headRef,
        repositoryScoped: false,
        collectAll: true,
      });
      const pr = chooseCurrentPullRequest(prs, identity, input.headRef, input.headSha);
      if (!pr) return null;
      const policies = await listPolicies(input.cwd, pr);
      return toCurrentPullRequestStatus(pr, identity, policies);
    },

    async getPullRequest(input: GetPullRequestOptions): Promise<PullRequestSummary> {
      const identity = await resolveIdentity(input.cwd);
      return toPullRequestSummary(await viewPullRequest(input.cwd, input.number), identity);
    },

    async getPullRequestHeadRef(input: GetPullRequestOptions): Promise<string> {
      return stripHeadPrefix((await viewPullRequest(input.cwd, input.number)).sourceRefName);
    },

    async getPullRequestCheckoutTarget(
      input: GetPullRequestOptions,
    ): Promise<PullRequestCheckoutTarget> {
      const pr = await viewPullRequest(input.cwd, input.number);
      const origin = await resolveRemoteUrl(input.cwd);
      return buildCheckoutTarget(pr, origin);
    },

    defaultCheckoutRefs({ headRef }) {
      return [{ remoteName: "origin", remoteRef: `refs/heads/${headRef}` }];
    },

    async listPullRequests(input: ListPullRequestsOptions): Promise<PullRequestSummary[]> {
      const identity = await resolveIdentity(input.cwd);
      return (await listPullRequests({ input })).map((pr) => toPullRequestSummary(pr, identity));
    },

    async listIssues(input: ListIssuesOptions): Promise<IssueSummary[]> {
      const identity = await resolveIdentity(input.cwd);
      return (await listIssues(input)).map((item) => toIssueSummary(item, identity));
    },

    async createPullRequest(input: CreatePullRequestOptions): Promise<PullRequestCreateResult> {
      const identity = await resolveIdentity(input.cwd);
      let contributorName = await resolveContributorName(input.cwd);
      if (!contributorName) {
        const accountName = await run(
          ["account", "show", "--query", "user.name", "--output", "tsv"],
          { cwd: input.cwd },
        );
        try {
          contributorName = await run(
            [
              "devops",
              "user",
              "show",
              "--user",
              accountName,
              "--organization",
              identity.organizationUrl,
              "--query",
              "user.displayName",
              "--output",
              "tsv",
            ],
            { cwd: input.cwd },
          );
        } catch {
          contributorName = accountName;
        }
      }
      const pr = await runJson(
        [
          "repos",
          "pr",
          "create",
          ...azureContextArgs(identity),
          "--source-branch",
          input.head,
          "--target-branch",
          input.base,
          "--title",
          input.title,
          "--description",
          formatPullRequestDescription(input.body, contributorName),
          ...outputArgs(),
        ],
        { cwd: input.cwd },
        AzurePullRequestSchema,
      );
      return { url: pullRequestUrl(pr, identity), number: pr.pullRequestId };
    },

    async mergePullRequest(input: MergePullRequestOptions): Promise<PullRequestMergeResult> {
      if (!isAzureDevOpsStatusFacts(input.status?.forgeSpecific)) {
        throw new Error("Azure DevOps merge facts are unavailable for this pull request");
      }
      if (input.status.forgeSpecific.autoCompleteEnabled) {
        throw new Error("Direct merge is not available because auto-complete is already enabled");
      }
      if (input.status.forgeSpecific.mergeStatus !== "succeeded") {
        throw new Error("Azure DevOps does not report this pull request as ready for direct merge");
      }
      if (
        input.status.forgeSpecific.policiesStatus !== "none" &&
        input.status.forgeSpecific.policiesStatus !== "success"
      ) {
        throw new Error("Azure DevOps pull request policies have not passed");
      }
      if (input.mergeMethod === "rebase") {
        throw new Error("Azure DevOps CLI does not support rebase completion");
      }
      const identity = await resolveIdentity(input.cwd);
      await run(
        [
          "repos",
          "pr",
          "update",
          "--id",
          String(input.prNumber),
          "--organization",
          identity.organizationUrl,
          "--status",
          "completed",
          "--squash",
          String(input.mergeMethod === "squash"),
          ...outputArgs(),
        ],
        { cwd: input.cwd },
      );
      return { success: true };
    },

    async enablePullRequestAutoMerge(
      input: EnablePullRequestAutoMergeOptions,
    ): Promise<PullRequestAutoMergeResult> {
      if (!isAzureDevOpsStatusFacts(input.status?.forgeSpecific)) {
        throw new Error("Azure DevOps merge facts are unavailable for this pull request");
      }
      if (input.status.forgeSpecific.autoCompleteEnabled) {
        throw new Error("Azure DevOps auto-complete is already enabled");
      }
      if (
        input.status.forgeSpecific.mergeStatus === "succeeded" &&
        (input.status.forgeSpecific.policiesStatus === "none" ||
          input.status.forgeSpecific.policiesStatus === "success")
      ) {
        throw new Error("Azure DevOps pull request is already ready for direct merge");
      }
      if (input.mergeMethod === "rebase") {
        throw new Error("Azure DevOps CLI does not support rebase auto-complete");
      }
      const identity = await resolveIdentity(input.cwd);
      await run(
        [
          "repos",
          "pr",
          "update",
          "--id",
          String(input.prNumber),
          "--organization",
          identity.organizationUrl,
          "--auto-complete",
          "true",
          "--squash",
          String(input.mergeMethod === "squash"),
          ...outputArgs(),
        ],
        { cwd: input.cwd },
      );
      return { success: true };
    },

    async disablePullRequestAutoMerge(
      input: DisablePullRequestAutoMergeOptions,
    ): Promise<PullRequestAutoMergeResult> {
      if (!isAzureDevOpsStatusFacts(input.status?.forgeSpecific)) {
        throw new Error("Azure DevOps merge facts are unavailable for this pull request");
      }
      if (!input.status.forgeSpecific.autoCompleteEnabled) {
        throw new Error("Azure DevOps auto-complete is not enabled");
      }
      const identity = await resolveIdentity(input.cwd);
      await run(
        [
          "repos",
          "pr",
          "update",
          "--id",
          String(input.prNumber),
          "--organization",
          identity.organizationUrl,
          "--auto-complete",
          "false",
          ...outputArgs(),
        ],
        { cwd: input.cwd },
      );
      return { success: true };
    },

    async getPullRequestTimeline(
      input: GetPullRequestTimelineOptions,
    ): Promise<PullRequestTimeline> {
      const result = {
        prNumber: input.prNumber,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
      };
      try {
        const identity = await resolveIdentity(input.cwd);
        const pr = await viewPullRequest(input.cwd, input.prNumber);
        const prUrl = pullRequestUrl(pr, identity);
        const threadResponse = await runJson(
          [
            "devops",
            "invoke",
            "--area",
            "git",
            "--resource",
            "pullRequestThreads",
            "--route-parameters",
            `project=${identity.project}`,
            `repositoryId=${pr.repository.id}`,
            `pullRequestId=${pr.pullRequestId}`,
            "--organization",
            identity.organizationUrl,
            "--api-version",
            "7.1",
            ...outputArgs(),
          ],
          { cwd: input.cwd },
          AzureThreadListSchema,
        );
        const threads = unwrapThreads(threadResponse);
        const items = threads
          .flatMap((thread) =>
            thread.comments.map((comment) => toTimelineComment(thread, comment, prUrl)),
          )
          .filter((item): item is PullRequestTimelineItem => item !== null)
          .sort(compareTimelineItems);
        return { ...result, items, truncated: false, error: null };
      } catch (error) {
        return { ...result, items: [], truncated: false, error: toTimelineError(error) };
      }
    },

    async getCheckDetails(_input: GetCheckDetailsOptions): Promise<CheckDetails> {
      throw new Error("Azure DevOps policy detail drill-down is unavailable");
    },

    async searchIssuesAndPrs(input: SearchIssuesAndPrsOptions): Promise<SearchResult> {
      if (input.force && !input.reason) {
        throw new Error("ForgeService forced read requires a reason");
      }
      const identity = await resolveIdentity(input.cwd);
      const kinds = normalizeForgeSearchKinds(input.kinds);
      const shouldFetchIssues = kinds.includes("issue");
      const shouldFetchPullRequests = kinds.includes("change_request");
      const [issueResult, pullRequestResult] = await Promise.allSettled([
        shouldFetchIssues
          ? listIssues({ cwd: input.cwd, query: input.query, limit: input.limit })
          : Promise.resolve(null),
        shouldFetchPullRequests ? listPullRequests({ input }) : Promise.resolve(null),
      ]);
      const requestedResults = [
        shouldFetchIssues ? issueResult : null,
        shouldFetchPullRequests ? pullRequestResult : null,
      ].filter((result) => result !== null);
      if (
        requestedResults.length > 0 &&
        requestedResults.every(
          (result) => result.status === "rejected" && isAzureSearchAuthFailure(result.reason),
        )
      ) {
        const authState = requestedResults.some(
          (result) => result.status === "rejected" && result.reason instanceof AzureCliMissingError,
        )
          ? "cli_missing"
          : "unauthenticated";
        return createUnavailableSearchResult(authState);
      }
      const failure = requestedResults.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected" && !isAzureSearchAuthFailure(result.reason),
      );
      if (failure) throw failure.reason;
      const issues =
        issueResult.status === "fulfilled"
          ? (issueResult.value ?? []).map((item) => toIssueSearchItem(item, identity))
          : [];
      const pullRequests =
        pullRequestResult.status === "fulfilled"
          ? (pullRequestResult.value ?? []).map((pr) => toPullRequestSearchItem(pr, identity))
          : [];
      const items: SearchResult["items"] = [...issues, ...pullRequests];
      items.sort(
        (left, right) => parseOptionalTime(right.updatedAt) - parseOptionalTime(left.updatedAt),
      );
      return {
        items,
        featuresEnabled: true,
        authState: "authenticated",
        githubFeaturesEnabled: true,
      };
    },

    invalidate(_input: { cwd: string }): void {},
  };
}
