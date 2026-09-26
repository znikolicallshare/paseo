import { GitPullRequest } from "lucide-react-native";
import type { ClientForgeViewModule } from "@/git/client-forge-module";

export const azureDevOpsForgeView = {
  id: "azure-devops",
  icon: GitPullRequest,
  brandColor: null,
} satisfies ClientForgeViewModule;
