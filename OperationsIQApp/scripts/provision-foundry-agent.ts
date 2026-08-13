/**
 * Provision the Operations IQ Foundry agent's tool catalog + instructions.
 *
 * Run with vite-node (needs the stub config so the browser-only registry deps
 * resolve under Node):
 *
 *   npm run agent:emit         # write the generated agent body to disk
 *   npm run agent:provision    # create/update the agent version in Foundry
 *   npm run agent:provision -- --dry-run
 *
 * Or directly:
 *   npx vite-node --config scripts/provision.vite.config.ts \
 *     scripts/provision-foundry-agent.ts -- --emit
 *
 * The flattened function-tool schemas come from `functionToolDefs()` (the single
 * source of truth in the registry); the system instructions come from the fenced
 * block in `docs/agent-instructions.md`. See
 * `docs/foundry-tool-catalog-provisioning.md` for the full runbook.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { functionToolDefs } from '../src/lib/agent/registry';
import {
  agentUrl,
  agentsUrl,
  buildAgentBody,
  extractSystemInstructions,
  toUpdateBody,
  type CreateAgentBody,
} from '../src/lib/agent/provisioning';

interface Cli {
  emit: boolean;
  provision: boolean;
  dryRun: boolean;
  out: string;
  help: boolean;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = {
    emit: false,
    provision: false,
    dryRun: false,
    out: 'agent-tools.generated.json',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--emit':
        cli.emit = true;
        break;
      case '--provision':
        cli.provision = true;
        break;
      case '--dry-run':
        cli.dryRun = true;
        break;
      case '--out':
        cli.out = argv[++i] ?? cli.out;
        break;
      case '-h':
      case '--help':
        cli.help = true;
        break;
      default:
        if (a.startsWith('--out=')) cli.out = a.slice('--out='.length);
        else console.warn(`Ignoring unknown argument: ${a}`);
    }
  }
  // Default action when nothing is requested.
  if (!cli.emit && !cli.provision && !cli.help) cli.emit = true;
  return cli;
}

const USAGE = `Provision the Operations IQ Foundry agent.

Usage:
  vite-node --config scripts/provision.vite.config.ts scripts/provision-foundry-agent.ts -- [options]

Options:
  --emit             Write the generated agent body to disk (default action).
  --out <path>       Output path for --emit (default: agent-tools.generated.json).
  --provision        Create the agent, or update it by cutting a new version
                     if FOUNDRY_AGENT_NAME already exists, via the agents API.
  --dry-run          With --provision, print the request but do not send it.
  -h, --help         Show this help.

Environment (required for --provision):
  FOUNDRY_PROJECT_ENDPOINT   https://<res>.services.ai.azure.com/api/projects/<project>
  FOUNDRY_AGENT_NAME         Agent name to create/update.
  FOUNDRY_MODEL              Model deployment name (e.g. gpt-4o).

Environment (optional):
  FOUNDRY_AGENT_DESCRIPTION  Human-readable description.
  FOUNDRY_INSTRUCTIONS_FILE  Path to instructions markdown
                             (default: docs/agent-instructions.md).
  FOUNDRY_API_VERSION        Agents API version (default: v1).
  FOUNDRY_TOKEN              Bearer token. If unset, falls back to
                             'az account get-access-token'.
`;

function defaultInstructionsPath(): string {
  return fileURLToPath(new URL('../docs/agent-instructions.md', import.meta.url));
}

function loadInstructions(): string {
  const path = process.env.FOUNDRY_INSTRUCTIONS_FILE ?? defaultInstructionsPath();
  const md = readFileSync(path, 'utf8');
  return extractSystemInstructions(md);
}

/** Build the agent body from env + the registry. Placeholders are used for
 *  name/model when only emitting, so a preview can be generated offline. */
function assembleBody(forProvision: boolean): CreateAgentBody {
  const tools = functionToolDefs();
  const instructions = loadInstructions();
  const name = process.env.FOUNDRY_AGENT_NAME ?? (forProvision ? '' : '<agent-name>');
  const model = process.env.FOUNDRY_MODEL ?? (forProvision ? '' : '<model-deployment>');
  return buildAgentBody({
    name,
    model,
    instructions,
    tools,
    description: process.env.FOUNDRY_AGENT_DESCRIPTION,
  });
}

function getToken(): string {
  const fromEnv = process.env.FOUNDRY_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const out = execFileSync(
      'az',
      [
        'account',
        'get-access-token',
        '--scope',
        'https://ai.azure.com/.default',
        '--query',
        'accessToken',
        '-o',
        'tsv',
      ],
      { encoding: 'utf8', shell: process.platform === 'win32' },
    );
    const token = out.trim();
    if (!token) throw new Error('empty token');
    return token;
  } catch (err) {
    throw new Error(
      "Could not acquire a token. Set FOUNDRY_TOKEN, or install the Azure CLI and run 'az login'.\n" +
        `Underlying error: ${(err as Error).message}`,
    );
  }
}

/**
 * Best-effort lookup of an already-provisioned agent so we can report whether
 * this run creates a brand-new agent or updates (re-versions) an existing one.
 * Never throws: any failure (404, transport error, unexpected status) resolves
 * to `null` and provisioning proceeds, since the POST creates-or-versions
 * regardless.
 */
async function fetchExistingAgent(
  endpoint: string,
  name: string,
  apiVersion: string,
  token: string,
): Promise<{ version?: string } | null> {
  const url = agentUrl(endpoint, name, apiVersion);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(
        `Could not check for an existing agent (${res.status}); proceeding to create/update.`,
      );
      return null;
    }
    const parsed = (await res.json()) as unknown;
    const version =
      parsed && typeof parsed === 'object' && 'version' in parsed
        ? String((parsed as { version?: unknown }).version)
        : undefined;
    return { version };
  } catch (err) {
    console.warn(
      `Existing-agent check failed (${(err as Error).message}); proceeding to create/update.`,
    );
    return null;
  }
}

async function provision(body: CreateAgentBody, dryRun: boolean): Promise<void> {
  const endpoint = requireEnv('FOUNDRY_PROJECT_ENDPOINT');
  const name = requireEnv('FOUNDRY_AGENT_NAME');
  requireEnv('FOUNDRY_MODEL');

  const apiVersion = process.env.FOUNDRY_API_VERSION ?? 'v1';
  const createUrl = agentsUrl(endpoint, apiVersion);
  const updateUrl = agentUrl(endpoint, name, apiVersion);
  if (dryRun) {
    console.log(`[dry-run] Would GET ${updateUrl} to detect an existing agent.`);
    console.log(`[dry-run] If it does NOT exist: POST ${createUrl} (create body, includes name).`);
    console.log(`[dry-run] If it EXISTS: POST ${updateUrl} (update body, no top-level name) to add a new version.`);
    console.log(`[dry-run] ${body.definition.tools.length} tools, ` +
      `${body.definition.instructions.length} chars of instructions`);
    console.log('[dry-run] create body:');
    console.log(JSON.stringify(body, null, 2));
    console.log('[dry-run] update body:');
    console.log(JSON.stringify(toUpdateBody(body), null, 2));
    return;
  }

  const token = getToken();

  const existing = await fetchExistingAgent(endpoint, name, apiVersion, token);
  // The create route (POST /agents, name in body) 409s once the name exists, so
  // route to the update route (POST /agents/{name}, name in the path) to cut a
  // new version of an already-provisioned agent.
  const url = existing ? updateUrl : createUrl;
  const payload: CreateAgentBody | ReturnType<typeof toUpdateBody> = existing
    ? toUpdateBody(body)
    : body;
  if (existing) {
    console.log(
      `Updating existing agent '${name}'` +
        `${existing.version ? ` (current version ${existing.version})` : ''}; ` +
        'the POST below adds a new version.',
    );
  } else {
    console.log(`Creating new agent '${name}'.`);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Agent provisioning failed (${res.status}):\n${text}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  const version =
    parsed && typeof parsed === 'object' && 'version' in parsed
      ? (parsed as { version?: unknown }).version
      : undefined;
  const verb = existing ? 'Updated' : 'Provisioned';
  console.log(
    `${verb} agent '${body.name}'${version ? ` version ${String(version)}` : ''} ` +
      `with ${body.definition.tools.length} tools.`,
  );
  console.log(JSON.stringify(parsed, null, 2));
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

async function main(): Promise<void> {
  // vite-node forwards CLI args after `--`; anything before is config/entry.
  const argv = process.argv.slice(2);
  const cli = parseArgs(argv);

  if (cli.help) {
    console.log(USAGE);
    return;
  }

  if (cli.emit) {
    const body = assembleBody(false);
    writeFileSync(cli.out, JSON.stringify(body, null, 2) + '\n', 'utf8');
    console.log(
      `Wrote ${cli.out}: ${body.definition.tools.length} tools, ` +
        `${body.definition.instructions.length} chars of instructions.`,
    );
  }

  if (cli.provision) {
    const body = assembleBody(true);
    await provision(body, cli.dryRun);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
