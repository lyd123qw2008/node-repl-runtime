// Integration demo cell: a real multi-step chain against the live IDE.
// Note there is no projectPath anywhere — the host injects it.
const hits = await cap.idea.search_text({ q: 'class', limit: 2 });
const problems = await cap.idea.get_file_problems({ filePath: hits.items[0].filePath });
const mods = await cap.idea.get_project_modules();

// Everything stays inside the kernel; only this summary reaches the model.
nodeRepl.write(JSON.stringify({
  hits: hits.items.length,
  more: hits.more,
  first: hits.items[0].filePath,
  problems: problems.errors.length,
  modules: mods.modules.length,
}, null, 2));
