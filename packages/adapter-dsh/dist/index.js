/**
 * The model-visible face: exactly two tools.
 *
 * This is the DSH side of the design. `js` and `js_reset` are the whole surface no
 * matter how many MCP servers are attached, which is what makes the tool-declaration
 * cost independent of how much is behind it — the same property node_repl gets from
 * exposing one `js` tool.
 *
 * Images are the one place where the face is not purely a text boundary. A cell's
 * `nodeRepl.emitImage(...)` reaches this file as an ordered block, and DSH's image block
 * carries an attachment reference rather than bytes — so `execute` commits the bytes to
 * the attachment store and `render` puts the reference back in the exact position the
 * cell emitted it. See `docs/05-image-content-blocks.zh-CN.md`.
 *
 * Kept framework-agnostic on purpose: `createNodeReplTools` returns plain definitions
 * so it can be tested without a host, and the Cordis plugin below only wires them up.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { JS_RESET_TOOL_DESCRIPTION, JS_TOOL_DESCRIPTION } from './descriptions.js';
export * from './descriptions.js';
/** Names are fixed: the model surface must not vary with what is attached. */
export const NODE_REPL_TOOL_NAMES = ['js', 'js_reset'];
const JS_PARAMETERS = {
    code: {
        type: 'string',
        required: true,
        description: 'JavaScript to run in the persistent kernel. Use nodeRepl.write(...) for the text you want returned.',
    },
    timeoutMs: {
        type: 'integer',
        description: 'Optional budget for this cell in milliseconds. Defaults to the runtime budget (30 s).',
    },
    title: {
        type: 'string',
        description: 'Optional short, single-line, user-visible description of what this cell does. Display only.',
    },
};
const RESET_PARAMETERS = {};
const IMAGE_OMITTED = 'image omitted';
/**
 * The display name for one committed image.
 *
 * The name is metadata, not identity: DSH stores images content-addressed
 * (`objects/<sha256>`, digest-verified deduplication), so a constant name can neither
 * collide with nor overwrite another image, and no path or lookup is derived from it.
 * Keeping it constant is therefore deliberate — one recognisable `node-repl` origin
 * instead of a taxonomy invented from free model text (`title`). The one part worth
 * deriving is the extension: `mediaType` is what the store validates and what the reader
 * re-derives, so a `.png` suffix on a jpeg block is a name contradicting its own bytes.
 */
function imageAttachmentName(mediaType) {
    const slash = mediaType.indexOf('/');
    const subtype = slash === -1 ? '' : mediaType.slice(slash + 1);
    if (subtype === '')
        return 'node-repl';
    return `node-repl.${subtype === 'jpeg' ? 'jpg' : subtype}`;
}
/**
 * Refuse images when the exact calling route cannot accept them.
 *
 * The failure this prevents is not cosmetic. An image on a text-only route fails the
 * *provider request*, taking the whole turn with it — long after the cell succeeded and
 * with nothing pointing back at the image as the cause. So the check runs here, at the one
 * place that knows both the route and the pixels.
 *
 * Two deliberate differences from `read_image`, which refuses by throwing: this tool has
 * already run its cell, so a missing image becomes visible text instead of costing the
 * cell's prose; and an unresolvable route proceeds, because a probe that cannot answer is
 * not evidence that the route is text-only.
 */
async function imageRouteRefusal(host, exec) {
    const routed = exec.agent?.session.requestHeader()?.config;
    const provider = routed?.provider ?? exec.agent?.options.provider;
    const model = routed?.model ?? exec.agent?.options.model;
    const llm = host.llm?.();
    if (llm === undefined || provider === undefined || model === undefined)
        return undefined;
    try {
        const info = await llm.resolveModelInfo(provider, model, exec.signal);
        if (info.inputModalities?.includes('image') === true)
            return undefined;
        return `model "${model}" does not declare image input`;
    }
    catch {
        return undefined;
    }
}
/**
 * Turn a cell's images into durable references, or say why not.
 *
 * DSH's image block carries a reference rather than bytes, and that is not bureaucracy:
 * `compaction-image-offload` replaces the oldest image occurrences with placeholder text
 * plus a read-only path when a route demands it, so the model can read them back later.
 * Inline bytes would trade that away for a context that can only grow.
 *
 * One `saveImages` call for the whole cell rather than a loop: the store validates the
 * batch — count, aggregate bytes, accepted media types — before committing any member,
 * which is exactly the "one tool result is one message" semantics this needs.
 */
async function commitImages(host, images, exec) {
    if (images.length === 0)
        return { refs: [] };
    const refusal = await imageRouteRefusal(host, exec);
    if (refusal !== undefined)
        return { refs: [], refusal };
    const store = host.attachments?.();
    if (store === undefined)
        return { refs: [], refusal: 'no attachment store is mounted' };
    try {
        const refs = await store.saveImages(images.map(image => ({
            data: Buffer.from(image.data, 'base64'),
            // The kernel restricted this to its own png/jpeg/webp allowlist before the block
            // existed, so the cast records a fact rather than asserting one. A store that
            // accepts fewer types still gets to refuse it, below.
            mediaType: image.mimeType,
            name: imageAttachmentName(image.mimeType),
        })));
        return { refs };
    }
    catch (error) {
        return { refs: [], refusal: error instanceof Error ? error.message : String(error) };
    }
}
/**
 * Rebuild the cell's ordered blocks for the model, substituting each image with its
 * reference — or, when it could not be committed, with a notice in that same position.
 * Order is the reason `blocks` exists, so a refusal must not shuffle the prose around it.
 */
function toToolBlocks(blocks, refs, refusal) {
    const toolBlocks = [];
    let imageIndex = 0;
    for (const block of blocks) {
        if (block.kind === 'text') {
            toolBlocks.push({ kind: 'text', text: block.text });
            continue;
        }
        const ref = refs[imageIndex];
        imageIndex++;
        toolBlocks.push(ref === undefined
            ? { kind: 'text', text: `[${IMAGE_OMITTED}: ${refusal ?? 'not stored'}]` }
            : { kind: 'image', attachment: ref });
    }
    return toolBlocks;
}
/**
 * Formatted as content blocks rather than `JSON.stringify`: the whole point of a REPL is
 * that what the cell wrote comes back readable, with real newlines — and an image comes
 * back as an image, in the position the cell put it.
 */
const cellOutput = {
    schema: { type: 'json' },
    render(_args, value) {
        const cell = value;
        const header = cell.status === 'ok'
            ? `ok (${cell.durationMs}ms)`
            : `${cell.status} (${cell.durationMs}ms)${cell.error === undefined ? '' : `: ${cell.error.name}: ${cell.error.message}`}`;
        const [first, ...rest] = cell.blocks;
        // The status lead folds into the first text block when there is one, so a text-only
        // cell renders exactly as it did before images existed.
        const rendered = first?.kind === 'text'
            ? [{ type: 'text', text: `${header}\n${first.text}` }]
            : [{ type: 'text', text: header }];
        for (const block of first?.kind === 'text' ? rest : cell.blocks) {
            rendered.push(block.kind === 'text'
                ? { type: 'text', text: block.text }
                : { type: 'image', attachment: block.attachment });
        }
        return rendered;
    },
};
/**
 * Hand a cell outcome to the tool contract.
 *
 * The one cast in this file, kept in one place, and it is a compiler limitation rather
 * than a shortcut: the contract types its value as `JsonValue`, a recursive alias with an
 * index signature, and TypeScript gives implicit index signatures to aliases only. DSH's
 * `ImageAttachmentRef` is an interface — it *is* lossless JSON, and the value handed over
 * here is the live store's own object, never reshaped — so the compiler cannot see what
 * the runtime already guarantees. Returning `never` makes the result assignable where the
 * contract wants `JsonValue` without this file restating that type.
 */
function forToolContract(value) {
    return value;
}
/** Build the two tool definitions over a runtime. */
export function createNodeReplTools(host) {
    const jsTool = defineTool({
        name: NODE_REPL_TOOL_NAMES[0],
        description: JS_TOOL_DESCRIPTION,
        parameters: JS_PARAMETERS,
        output: cellOutput,
        // The return type is deliberately inferred: `forToolContract` yields `never`, which is
        // what lets the value satisfy the contract's `JsonValue`; annotating it here would put
        // the unassignable shape back.
        async execute(args, exec) {
            const result = await host.runtime.js(args.code, {
                ...args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs },
                ...args.title === undefined ? {} : { title: args.title },
            });
            const images = result.blocks.filter((block) => block.kind === 'image');
            const { refs, refusal } = await commitImages(host, images, exec);
            return forToolContract({
                status: result.status,
                durationMs: result.durationMs,
                blocks: toToolBlocks(result.blocks, refs, refusal),
                ...result.error === undefined ? {} : { error: { name: result.error.name, message: result.error.message } },
            });
        },
    });
    const resetTool = defineTool({
        name: NODE_REPL_TOOL_NAMES[1],
        description: JS_RESET_TOOL_DESCRIPTION,
        parameters: RESET_PARAMETERS,
        output: cellOutput,
        async execute(_args, _exec) {
            await host.runtime.jsReset();
            return forToolContract({
                status: 'ok',
                durationMs: 0,
                blocks: [{ kind: 'text', text: 'kernel reset; capabilities re-installed' }],
            });
        },
    });
    return [jsTool, resetTool];
}
/** Cordis plugin name used by Loader diagnostics. */
export const name = 'node-repl-runtime-adapter-dsh';
/**
 * Waits for the tool runtime and for a runtime supplied by a bootstrap plugin.
 *
 * The adapter deliberately does not create the runtime itself: which MCP servers to
 * attach, and with which host-owned arguments, is a composition decision. The attachment
 * store and LLM service are a different case — they are optional, so they are read per
 * call instead of being waited for.
 */
export const inject = ['tools', 'nodeReplRuntime'];
/** Register exactly `js` and `js_reset`. */
export function apply(ctx) {
    const definitions = createNodeReplTools({
        runtime: ctx.nodeReplRuntime,
        attachments: () => ctx.get('attachments'),
        llm: () => ctx.get('llm'),
    });
    const disposers = definitions.map(definition => ctx.tools.register(definition));
    ctx.effect(() => () => {
        for (const dispose of disposers.reverse())
            dispose();
    }, 'node-repl-runtime-adapter-dsh: unregister the two-tool face');
}
//# sourceMappingURL=index.js.map