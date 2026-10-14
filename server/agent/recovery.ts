import type { Run } from './types.ts';

// Error feedback is real executor output. Keep unresolved repairs across exchanges;
// never infer a semantic answer or turn the failed attempt into committed state.
export function rememberRecovery(run: Run, tool: string, args: any, result: any) {
  const hints = run.recoveryHints || [];
  if (tool === 'record_finding' && Array.isArray(result?.saved))
    run.recoveryHints = hints.filter(
      (h) => !result.saved.some((f: any) => f.changeId === h.changeId && f.refId === h.refId),
    );
  const errors = result?.error ? [{ ...result.error }] : Array.isArray(result?.errors) ? result.errors : [];
  for (const error of errors) {
    const attempted = tool === 'record_finding' ? args?.findings?.[error.index] : args;
    const hint = {
      tool,
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      ...(attempted?.changeId ? { changeId: attempted.changeId } : {}),
      ...(attempted?.refId ? { refId: attempted.refId } : {}),
    };
    run.recoveryHints = [
      ...(run.recoveryHints || hints).filter(
        (h) =>
          !(
            h.tool === tool &&
            h.code === hint.code &&
            h.changeId === hint.changeId &&
            h.refId === hint.refId
          ),
      ),
      hint,
    ].slice(-8);
  }
  if (!errors.length && !result?.errors?.length && tool !== 'record_finding')
    run.recoveryHints = (run.recoveryHints || hints).filter((h) => h.tool !== tool);
}
