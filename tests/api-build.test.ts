import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";

test("compiled API loads in plain Node without a TypeScript runtime", async () => {
  const output = await mkdtemp(join(tmpdir(), "ronda-api-"));
  try {
    const program = ts.createProgram([resolve("api/planner.ts")], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      esModuleInterop: true,
      skipLibCheck: true,
      strict: true,
      noEmitOnError: true,
      rootDir: process.cwd(),
      outDir: output,
    });
    const emitted = program.emit();
    const errors = ts.getPreEmitDiagnostics(program).concat(emitted.diagnostics);
    assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: name => name,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    }));
    await writeFile(join(output, "package.json"), JSON.stringify({ type: "module" }));
    await symlink(resolve("node_modules"), join(output, "node_modules"), "dir");
    const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import api from './api/planner.js';
      const response = await api.fetch(new Request('https://example.test/api/planner?action=admin'));
      if (response.status !== 401) throw new Error('Expected protected admin response');
      console.log('Compiled API OK');
    `], {
      cwd: output,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "", DATABASE_URL: "postgresql://localhost/unused" },
    });
    assert.match(result, /Compiled API OK/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
