/**
 * `integration:demo` — attach any MCP server and drive it from one persistent kernel.
 *
 * This is the shortest honest proof that integrating an MCP server costs
 * configuration and nothing else: no provider-specific source file exists to add,
 * because this command is the whole adapter.
 *
 *   node packages/runtime/dist/cli.js \
 *     --id idea \
 *     --url http://127.0.0.1:64342/stream \
 *     --inject projectPath=D:/path/to/project \
 *     [--code 'nodeRepl.write(capHelp("idea"));' | --code-file cell.js]
 *
 * Without `--code`/`--code-file` it prints the projected catalog, which is the
 * discovery step.
 */
export {};
//# sourceMappingURL=cli.d.ts.map