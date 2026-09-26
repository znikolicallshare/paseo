import type { CheckoutPrMergeMethod } from "@getpaseo/protocol/messages";
import { z } from "zod";
import {
  defineForgeFacts,
  type ClientForgeLogicModule,
  type MergeCapability,
} from "@/git/client-forge-module";

const AzureDevOpsMergeFactsSchema = z
  .object({
    forge: z.literal("azure-devops"),
    mergeStatus: z.string(),
    autoCompleteEnabled: z.boolean(),
    policiesStatus: z.enum(["none", "pending", "success", "failure"]),
  })
  .passthrough();

type AzureDevOpsMergeFacts = z.infer<typeof AzureDevOpsMergeFactsSchema>;

const AZURE_DEVOPS_MERGE_METHODS: CheckoutPrMergeMethod[] = ["merge", "squash"];

function deriveAzureDevOpsMergeCapability(facts: AzureDevOpsMergeFacts): MergeCapability {
  const autoMergeEnabled = facts.autoCompleteEnabled;
  const directMergeReady =
    facts.mergeStatus === "succeeded" &&
    !autoMergeEnabled &&
    (facts.policiesStatus === "none" || facts.policiesStatus === "success");
  return {
    directMergeReady,
    canEnableAutoMerge: !autoMergeEnabled && !directMergeReady,
    autoMergeEnabled,
    canDisableAutoMerge: autoMergeEnabled,
    mergeBlockedByQueue: false,
    allowedMethods: AZURE_DEVOPS_MERGE_METHODS,
    preferredMethod: null,
  };
}

export const azureDevOpsForgeLogic = {
  id: "azure-devops",
  facts: defineForgeFacts({
    family: "azure-devops",
    schema: AzureDevOpsMergeFactsSchema,
    deriveMergeCapability: deriveAzureDevOpsMergeCapability,
  }),
} satisfies ClientForgeLogicModule<AzureDevOpsMergeFacts>;
