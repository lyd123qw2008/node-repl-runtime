# Upstream provenance policy

Tier 00 contains only own Node built-in code and imports no DSH package/source.
Tier 10 may load only the exact isolated `koffi@3.1.1` pin recorded in the source
manifest; it must not load DSH code or create a production dependency. Tier 10 may
also compile only this repository's own `native/win32-audit.cpp` on the pinned public
GitHub Actions Windows runner and locally verify the returned artifact; no upstream
native source or prebuilt native dependency is copied into the runtime.

If work proceeds to Tier 20, reimplement narrow semantics from fixed upstream
sources rather than importing DSH packages or maintaining a DSH fork.  The initial
reference pin is documented in [../SOURCE-MANIFEST.md](../SOURCE-MANIFEST.md).
Before copying any source, add:

1. exact source path and immutable revision/tag;
2. license and preserved SPDX/header text;
3. a local patch ledger entry explaining every divergence;
4. equivalent local tests; and
5. direct dependency/version/notice entries (including an exact `koffi@3.1.1` pin).

Never add `workspace:*`, `link:`, `@deepseek-ai/*`, a DSH `src/*` deep import, or a
personal DSH/Qwen fork as a production node-repl-runtime dependency.
