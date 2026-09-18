/**
 * Mount the runtime into a DSH profile from configuration alone.
 *
 * This is the piece that was missing: the adapter declares `inject: ['nodeReplRuntime']`,
 * so without a plugin providing that service the two-tool face can never register.
 * This bootstrap creates the runtime and provides it.
 *
 * Provider configuration is deliberately not committed anywhere: which MCP servers to
 * attach, and which host-owned arguments to inject, are machine-local facts. It is read
 * from, in order:
 *
 *   1. `config.providers` in this plugin's own entry,
 *   2. `NODE_REPL_PROVIDERS` (inline JSON),
 *   3. `NODE_REPL_PROVIDERS_FILE` (path to a JSON file).
 *
 * Nothing found is a load failure, not an empty runtime: a profile that silently came up
 * with no capabilities would look like a working setup and quietly do nothing.
 */
import { readFileSync } from 'node:fs';
import { createCapabilityRuntime } from '@node-repl-runtime/runtime';
export const name = 'node-repl-runtime-bootstrap';
/** Needs the tool runtime only to noop until the face registers; the face owns tools. */
export const inject = [];
/** Read provider specs from config or the environment. Exported for tests. */
export function resolveProviders(config, env = process.env) {
    if (config.providers !== undefined && config.providers.length > 0)
        return config.providers;
    const inline = env.NODE_REPL_PROVIDERS;
    if (inline !== undefined && inline.trim() !== '') {
        const parsed = JSON.parse(inline);
        return Array.isArray(parsed) ? parsed : parsed.providers ?? [];
    }
    const file = env.NODE_REPL_PROVIDERS_FILE;
    if (file !== undefined && file.trim() !== '') {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? parsed : parsed.providers ?? [];
    }
    throw new Error('node-repl-runtime: no MCP providers configured. Set config.providers on this plugin, '
        + 'or export NODE_REPL_PROVIDERS (inline JSON) / NODE_REPL_PROVIDERS_FILE (path to JSON).');
}
export const apply = async (ctx, config = {}) => {
    const providers = resolveProviders(config);
    const runtime = await createCapabilityRuntime({
        providers,
        ...config.cellTimeoutMs === undefined ? {} : { cellTimeoutMs: config.cellTimeoutMs },
    });
    ctx.provide('nodeReplRuntime', runtime);
    ctx.effect(() => () => {
        void runtime.dispose();
    }, 'node-repl-runtime: dispose kernels, bridge and MCP sessions');
    const report = runtime.catalog()
        .map(provider => `${provider.id}=${provider.operations.length}`)
        .join(' ');
    console.log(`[node-repl-runtime] mounted ${report}`
        + (providers.some(provider => Object.keys(provider.inject ?? {}).length > 0)
            ? ` | host-owned args injected: ${providers.flatMap(provider => Object.keys(provider.inject ?? {})).join(',')}`
            : ''));
};
//# sourceMappingURL=index.js.map