/**
 * Pure helpers for provisioning the Foundry agent definition.
 *
 * These are deliberately free of filesystem, network and browser-only imports
 * so they can be unit-tested under Vitest (node env) and reused by the
 * `scripts/provision-foundry-agent.ts` CLI. The CLI owns all the fs / fetch /
 * `az` side effects; this module only transforms in-memory data.
 */
import type { FunctionToolDef } from './registry';

/** The `definition` block of a prompt-kind Foundry agent. */
export interface PromptAgentDefinition {
  kind: 'prompt';
  model: string;
  instructions: string;
  tools: FunctionToolDef[];
}

/**
 * Request body for **creating** an agent via `POST {endpoint}/agents`.
 * The top-level `name` is what makes this the create operation; the agents API
 * rejects a create for a name that already exists with HTTP 409. To publish a
 * new version of an existing agent, use `UpdateAgentBody` against `agentUrl()`.
 */
export interface CreateAgentBody {
  name: string;
  description?: string;
  definition: PromptAgentDefinition;
}

/**
 * Request body for **updating** an existing agent via
 * `POST {endpoint}/agents/{name}` — i.e. cutting a new version. The agent name
 * lives in the URL path, not the body, so this shape intentionally omits `name`.
 * The service adds a new version when the definition changed and otherwise
 * returns the existing latest version.
 */
export interface UpdateAgentBody {
  description?: string;
  definition: PromptAgentDefinition;
}

export interface BuildAgentOptions {
  name: string;
  model: string;
  instructions: string;
  tools: FunctionToolDef[];
  description?: string;
}

/**
 * Extract the system-instructions payload from `docs/agent-instructions.md`.
 *
 * The instructions live in the single fenced code block that follows the
 * `## System instructions` heading. We locate that heading, then return the
 * contents of the next fenced block (``` ... ```), trimmed. The optional info
 * string on the opening fence (e.g. ```text) is ignored.
 */
export function extractSystemInstructions(markdown: string): string {
  const headingRe = /^##\s+System instructions\b.*$/im;
  const heading = headingRe.exec(markdown);
  if (!heading) {
    throw new Error("Could not find a '## System instructions' heading in the instructions markdown.");
  }
  const afterHeading = heading.index + heading[0].length;

  const openFence = /^```[^\n]*\n/m;
  openFence.lastIndex = afterHeading;
  const fence = execFrom(openFence, markdown, afterHeading);
  if (!fence) {
    throw new Error("Could not find a fenced code block after the '## System instructions' heading.");
  }
  const bodyStart = fence.index + fence[0].length;

  const closeFence = /^```\s*$/m;
  const close = execFrom(closeFence, markdown, bodyStart);
  if (!close) {
    throw new Error('The system-instructions code block is not closed with a matching fence.');
  }

  const body = markdown.slice(bodyStart, close.index).trim();
  if (!body) {
    throw new Error('The system-instructions code block is empty.');
  }
  return body;
}

/** Run a sticky regex starting at `from`, returning the first match or null. */
function execFrom(re: RegExp, s: string, from: number): RegExpExecArray | null {
  const sticky = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  sticky.lastIndex = from;
  return sticky.exec(s);
}

/** Assemble the **create**-agent request body (`POST {endpoint}/agents`). */
export function buildAgentBody(opts: BuildAgentOptions): CreateAgentBody {
  if (!opts.name) throw new Error('Agent name is required.');
  if (!opts.model) throw new Error('Model deployment name is required.');
  if (!opts.instructions.trim()) throw new Error('Instructions must not be empty.');
  if (opts.tools.length === 0) throw new Error('Refusing to provision an agent with zero tools.');

  const body: CreateAgentBody = {
    name: opts.name,
    definition: {
      kind: 'prompt',
      model: opts.model,
      instructions: opts.instructions,
      tools: opts.tools,
    },
  };
  if (opts.description) body.description = opts.description;
  return body;
}

/**
 * Derive the **update** body (`POST {endpoint}/agents/{name}`) from a create
 * body by dropping the top-level `name` (which moves to the URL path). Used to
 * publish a new version of an already-provisioned agent, since posting the
 * create body to `/agents` returns HTTP 409 once the name exists.
 */
export function toUpdateBody(body: CreateAgentBody): UpdateAgentBody {
  const update: UpdateAgentBody = { definition: body.definition };
  if (body.description) update.description = body.description;
  return update;
}

/**
 * Build the agents-API URL for **creating** a brand-new agent. Posting a
 * create body here for a name that already exists returns HTTP 409; use
 * `agentUrl()` to update (re-version) an existing agent instead.
 * `endpoint` is the project endpoint, e.g.
 * `https://<res>.services.ai.azure.com/api/projects/<project>`.
 */
export function agentsUrl(endpoint: string, apiVersion = 'v1'): string {
  const base = endpoint.replace(/\/+$/, '');
  return `${base}/agents?api-version=${encodeURIComponent(apiVersion)}`;
}

/**
 * Build the agents-API URL for a single named agent. A `GET` checks whether the
 * agent exists; a `POST` of an `UpdateAgentBody` publishes a new version of it
 * (the update operation). `endpoint` is the project endpoint, e.g.
 * `https://<res>.services.ai.azure.com/api/projects/<project>`.
 */
export function agentUrl(endpoint: string, name: string, apiVersion = 'v1'): string {
  const base = endpoint.replace(/\/+$/, '');
  return `${base}/agents/${encodeURIComponent(name)}?api-version=${encodeURIComponent(apiVersion)}`;
}
