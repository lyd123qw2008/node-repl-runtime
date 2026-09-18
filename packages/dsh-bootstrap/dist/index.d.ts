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
import type { Context } from '@deepseek-ai/cordis';
import { type McpProviderSpec } from '@node-repl-runtime/runtime';
export declare const name = "node-repl-runtime-bootstrap";
/** Needs the tool runtime only to noop until the face registers; the face owns tools. */
export declare const inject: readonly [];
export interface NodeReplBootstrapConfig {
    readonly providers?: readonly McpProviderSpec[];
    /** Default per-cell budget. */
    readonly cellTimeoutMs?: number;
}
/** Read provider specs from config or the environment. Exported for tests. */
export declare function resolveProviders(config: NodeReplBootstrapConfig, env?: Readonly<Record<string, string | undefined>>): readonly McpProviderSpec[];
export declare const apply: (ctx: Context, config?: NodeReplBootstrapConfig) => Promise<void>;
//# sourceMappingURL=index.d.ts.map