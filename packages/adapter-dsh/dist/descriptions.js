/**
 * The model-visible documentation for the two-tool face.
 *
 * With only `js` and `js_reset`, this text *is* the API documentation: everything the
 * model needs to know about the kernel, discovery, output and host-owned arguments has
 * to live here, because there is no catalog tool to carry it. That makes this file a
 * load-bearing artifact rather than a comment — treat a change here as an interface
 * change, and keep it measured (see `docs/03-integration-spec.zh-CN.md`).
 */
export const JS_TOOL_DESCRIPTION = [
    'Run JavaScript in one persistent node_repl-style kernel with top-level await, then continue in later calls with everything still in scope.',
    '',
    'Capabilities: `cap` is already installed. Discover with `nodeRepl.write(capHelp())` for the provider list, or `nodeRepl.write(capHelp("providerId"))` for that provider\'s operations. Call an operation as `await cap.<provider>.<operation>({...})` — names are the provider\'s own, e.g. `await cap.idea.search_text({ q: "class" })`. The full descriptor for one operation is `cap.describe("idea.search_text")`: it carries that operation\'s input schema and, when the server declares one, the schema of its result. Read it before guessing a result shape.',
    '',
    'Output: nothing is returned implicitly. Use `nodeRepl.write(value)` for the text you want back; `console.log` is captured too. Whatever you compute but do not write stays in the kernel, so filter and summarise there instead of returning raw payloads.',
    '',
    'Images: pixels never come back on their own either. An operation that captures a screen puts them on its result as `_images` — `{ mimeType, data }`, base64 — e.g. `const r = await cap.cua.get_window_state({ pid, window_id })`. To see one, emit it: `await nodeRepl.emitImage("data:" + r._images[0].mimeType + ";base64," + r._images[0].data)`. Emitted images return in order alongside your text, so emit before writing when the image should come first; an `_images` entry you never emit costs no context, which is why looking is cheap enough to do whenever you need to verify instead of acting blind. Per cell: at most 8 images, 4 MB each, PNG/JPEG/WebP only — anything refused is reported as text in the image\'s place.',
    '',
    'Bindings: they persist until `js_reset`. Prefer `var` for any name you may define again — re-declaring a `const`/`let`/`function`/`class` in a later call (usually a helper an earlier call already defined) fails that cell with `SyntaxError: Identifier \'name\' has already been declared`; use `var`, a new name, a block `{ ... }`, or `js_reset`. To change a value, assign to the existing name. A call that throws keeps the bindings it already declared.',
    '',
    'Statement style: end every top-level statement with an explicit `;`. The kernel injects snapshot code at each statement boundary, so a missing semicolon fails the whole cell with `SyntaxError: Unexpected identifier \'__qwen_repl_..._snapshot\'`; add the `;` and rerun.',
    '',
    'Runtime rules: top-level `await` works; `await import("package")` works, but top-level static `import` does not; `process` is not available; a cell that overruns its budget is cancelled so the kernel stays usable — earlier bindings normally survive, but a cell that will not stop restarts the kernel and discards them.',
    '',
    'Kernel lifetime: bindings live in the kernel process until `js_reset`, so whatever you leave at top level keeps costing memory — null out large values (`r = null`) once you are done with them, especially a `_images` screenshot you no longer need. Do not spawn a detached process from a cell: it outlives the kernel and nothing reaps it. If `cap` is ever undefined, the kernel was replaced (a crash or a kill): call `js_reset` to reinstall the catalog and start clean.',
    '',
    'Some arguments are host-owned and are injected for you — they are absent from operation schemas and must not be passed. If a call reports an argument as host-owned, call the operation without it.',
].join('\n');
export const JS_RESET_TOOL_DESCRIPTION = 'Discard everything the kernel is holding: all bindings and any in-memory state. Capabilities are re-installed immediately, so `cap` keeps working. Use when state has become confusing, to free memory after large work, or to recover the kernel after a cell would not stop.';
//# sourceMappingURL=descriptions.js.map