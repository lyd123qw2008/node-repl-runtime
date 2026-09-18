// Probe: what can a cell actually import in the current setup?
const report = {};
for (const specifier of ['node:path', 'node:fs', 'node:crypto', 'zod', '@modelcontextprotocol/client', 'playwright']) {
  try {
    const mod = await import(specifier);
    report[specifier] = 'OK (' + Object.keys(mod).length + ' exports)';
  } catch (error) {
    report[specifier] = 'FAIL: ' + String(error.message).slice(0, 70);
  }
}
nodeRepl.write(JSON.stringify(report, null, 2));
