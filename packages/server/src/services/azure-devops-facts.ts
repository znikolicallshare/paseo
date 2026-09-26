import type { ForgeSpecificStatusFacts } from "./forge-service.js";

export interface AzureDevOpsStatusFacts {
  mergeStatus: string;
  autoCompleteEnabled: boolean;
  policiesStatus: "none" | "pending" | "success" | "failure";
}

export type AzureDevOpsForgeSpecificStatusFacts = ForgeSpecificStatusFacts & {
  forge: "azure-devops";
} & AzureDevOpsStatusFacts;

export function isAzureDevOpsStatusFacts(
  facts: ForgeSpecificStatusFacts | null | undefined,
): facts is AzureDevOpsForgeSpecificStatusFacts {
  return facts?.forge === "azure-devops";
}
