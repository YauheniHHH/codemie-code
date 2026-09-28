import { describe, it, expect } from 'vitest';
import { exec } from '../exec.js';

// Real, unmocked spawns — exec()'s shell:true quoting logic only breaks under
// an actual shell, so mocking `spawn` (as other suites do) can't catch a
// regression here. Uses `node -e` as a portable "shell command" since node is
// guaranteed present in this test environment.
describe('exec() shell:true quoting', () => {
  it('passes a zero-arg raw shell command line through unquoted (curl | bash, hook commands)', async () => {
    // Mirrors native-installer.ts's installer command and hooks/executor.ts's
    // hook.command: a full command line assembled by the caller, invoked as
    // exec(fullLine, [], { shell: true }). Quoting the whole line would turn
    // it into a single literal (nonexistent) program name.
    const result = await exec('node -e "console.log(1 + 1)"', [], { shell: true });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('2');
  });

  it('still quotes a structured command when combined with separate args', async () => {
    // Mirrors codex.plugin.ts/gemini.plugin.ts: exec(cliCommand, ['--version'], { shell: true })
    // where cliCommand may be an env-overridden binary name/path containing spaces
    // or shell metacharacters. A malicious value here must not be able to chain
    // a second command via a shell operator. The injected command is a harmless
    // echo whose marker only reaches stdout if the shell split on `&`.
    const result = await exec('echo SAFE & echo INJECTED_MARKER', ['--version'], { shell: true });

    expect(result.stdout).not.toContain('INJECTED_MARKER');
    expect(result.code).not.toBe(0);
  });

  it('quotes structured args that contain spaces', async () => {
    const result = await exec('node', ['-e', 'console.log("has space")'], { shell: true });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('has space');
  });
});
