/**
 * Provisioning stub for `echarts`. Chart rendering (`chartRender.ts`) is only
 * exercised at tool run time, never during schema provisioning, so a no-op
 * `init` is enough to satisfy the import graph in Node.
 */
export const init = (): unknown => ({});
export default { init };
