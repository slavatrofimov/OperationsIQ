/**
 * Provisioning stub for `src/lib/msal.ts`.
 *
 * The tool registry transitively imports the real MSAL wrapper, which
 * instantiates a browser `PublicClientApplication` at module load (it reads
 * `window.location`). Provisioning only needs each tool's *metadata*
 * (name/description/parameters) and never calls `run()`, so we alias the MSAL
 * module to these no-ops when generating/publishing tool schemas in Node.
 *
 * Mirrors the mock in `registryTools.test.ts`.
 */
export const getEventhouseToken = async (): Promise<string> => '';
export const getFabricApiToken = async (): Promise<string> => '';
export const notifyEventhouseSignInRequired = (): void => {};
export class EventhouseSignInRequiredError extends Error {}
