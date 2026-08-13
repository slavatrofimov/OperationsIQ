---
id: agent-design
title: Agent design
sidebar_position: 7
---

# Agent design (Operations Advisor)

Operations IQ embeds an assistant called the **Operations Advisor** — an
Azure AI Foundry agent (referenced by `VITE_FOUNDRY_AGENT_NAME`) that helps users
explore, forecast, and interpret signals. It calls **client-side tools** defined
in `src/lib/agent/`.

## Where behavior lives

| Concern | Location |
| --- | --- |
| Persona, workflow, output format, safety rules | `OperationsIQApp/docs/agent-instructions.md` (versioned source of truth) |
| Runtime system instructions | Azure AI Foundry agent config (server-side, referenced by `VITE_FOUNDRY_AGENT_NAME`) |
| Tool implementations | `src/lib/agent/` (`tools/*.ts`, registered in `registry.ts`) |
| Tool design notes | `OperationsIQApp/docs/agent-tool-design.md` |
| UI | `src/components/OperationsAdvisorPanel.tsx`, `OperationsAdvisorButton.tsx` |

## The tool catalog

The registry (`src/lib/agent/registry.ts`) exposes **~47 flattened function
tools**: analysis/insight tools (`tools/*.ts` — forecast, decompose,
detect_discords, diagnose_anomalies, analyze_spectrum, detect_change_point,
mine_processes, …), read-only support tools (`resolve_tags`, `describe_tag`,
`get_current_time`, `list_investigations`, …), and 5 **UI-control** tools spread
in from `tools/uiControlTools.ts` (`describe_current_page`, `read_current_results`,
`navigate_to_page`, `set_page_params`, `run_current_page`). See
`agent-instructions.md` for the full, described catalog.

## The sync contract

The prompt and the client-side tools must **co-evolve**: a tool rename, a new
argument, or a new safety boundary is meaningless if the prompt doesn't know about
it. Therefore:

- When you change the Foundry instructions, update the "System instructions" block
  in `agent-instructions.md` in the **same** change.
- When you add/rename/modify a tool in `src/lib/agent/`, review
  `agent-instructions.md` and `agent-tool-design.md`.
- Treat drift between these docs and the Foundry agent as a **bug**. Consider
  stamping the Foundry agent description with the git SHA of the last sync.

## Design principles (from the instructions)

- **State the finding first**, then the "why", then the caveats.
- **Never invent data** — answer from tool results, and surface governed
  [signal metadata](/user/diagnose/signal-metadata) (e.g. via `describe_tag`).
- Be precise, concise, and action-oriented.

## Related

- Read the authoritative `agent-instructions.md` and `agent-tool-design.md` in the
  repo before changing agent behavior.
- [Extending the app → Add an agent tool](./extending-modules#add-an-agent-tool).
