/**
 * The model-visible documentation for the two-tool face.
 *
 * With only `js` and `js_reset`, this text *is* the API documentation: everything the
 * model needs to know about the kernel, discovery, output and host-owned arguments has
 * to live here, because there is no catalog tool to carry it. That makes this file a
 * load-bearing artifact rather than a comment — treat a change here as an interface
 * change, and keep it measured (see `docs/03-integration-spec.zh-CN.md`).
 */
export declare const JS_TOOL_DESCRIPTION: string;
export declare const JS_RESET_TOOL_DESCRIPTION = "Discard everything the kernel is holding: all bindings and any in-memory state. Capabilities are re-installed immediately, so `cap` keeps working. Use when state has become confusing, to free memory after large work, or to recover the kernel after a cell would not stop.";
//# sourceMappingURL=descriptions.d.ts.map