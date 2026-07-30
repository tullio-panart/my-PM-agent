import { readFile } from "node:fs/promises";

export type AgentStatus = "active" | "coming-soon";

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  status: AgentStatus;
  workflowPath: string;
  examplePrompts: string[];
}

interface AgentRegistryFile {
  schemaVersion: number;
  agents: AgentDefinition[];
}

const AGENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WORKFLOW_PATH_PATTERN = /^\/webhook\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const DEFAULT_AGENTS: readonly AgentDefinition[] = Object.freeze([
  {
    id: "project-manager",
    name: "Project Manager",
    description:
      "Plans projects, analyses meetings, and turns decisions into safe next actions.",
    status: "active",
    workflowPath: "/webhook/chat",
    examplePrompts: [
      "Turn these meeting notes into decisions and action items",
      "Build a practical project plan from this document",
      "Show me the highest-priority work in my local project",
    ],
  },
]);

function isAgentDefinition(value: unknown): value is AgentDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    AGENT_ID_PATTERN.test(candidate.id) &&
    typeof candidate.name === "string" &&
    candidate.name.trim().length > 0 &&
    candidate.name.length <= 80 &&
    typeof candidate.description === "string" &&
    candidate.description.trim().length > 0 &&
    candidate.description.length <= 240 &&
    (candidate.status === "active" || candidate.status === "coming-soon") &&
    typeof candidate.workflowPath === "string" &&
    Array.isArray(candidate.examplePrompts) &&
    candidate.examplePrompts.every(
      (prompt) => typeof prompt === "string" && prompt.trim().length > 0,
    )
  );
}

export async function loadAgentRegistry(
  registryPath: string,
): Promise<readonly AgentDefinition[]> {
  const parsed = JSON.parse(
    await readFile(registryPath, "utf8"),
  ) as AgentRegistryFile;

  if (
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.agents) ||
    parsed.agents.length === 0 ||
    !parsed.agents.every(isAgentDefinition)
  ) {
    throw new Error("Agent registry is invalid.");
  }

  const ids = parsed.agents.map((agent) => agent.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Agent registry contains duplicate agent IDs.");
  }
  if (!parsed.agents.some((agent) => agent.status === "active")) {
    throw new Error("Agent registry must contain at least one active agent.");
  }
  for (const agent of parsed.agents) {
    if (
      agent.status === "active" &&
      !WORKFLOW_PATH_PATTERN.test(agent.workflowPath)
    ) {
      throw new Error(
        `Active agent "${agent.id}" needs an internal webhook path.`,
      );
    }
    if (agent.status === "coming-soon" && agent.workflowPath !== "") {
      throw new Error(
        `Coming-soon agent "${agent.id}" must not expose a workflow path.`,
      );
    }
  }

  return parsed.agents.map((agent) => ({
    ...agent,
    name: agent.name.trim(),
    description: agent.description.trim(),
    examplePrompts: agent.examplePrompts.map((prompt) => prompt.trim()),
  }));
}

export function publicAgentDefinitions(
  agents: readonly AgentDefinition[],
): Array<Omit<AgentDefinition, "workflowPath">> {
  return agents.map(
    ({ id, name, description, status, examplePrompts }) => ({
      id,
      name,
      description,
      status,
      examplePrompts,
    }),
  );
}
