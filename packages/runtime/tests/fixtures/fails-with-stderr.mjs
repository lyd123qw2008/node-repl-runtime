/**
 * A stdio MCP server that fails the way a broken one does: it says why on stderr, then exits.
 *
 * The SDK's own error for that is about the connection ("Connection closed"), which tells a reader
 * nothing. This exists to prove the child's last words reach `failures`/`capHelp()` instead.
 */

process.stderr.write('[fixture] missing dependency: zod is not installed\n')
process.exit(3)
