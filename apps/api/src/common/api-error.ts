/** Shape of every error response. Says what happened and what to do next. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** What the user can do about it. */
    action: string;
    /** Correlates with the server log for unexpected errors. */
    ref?: string;
    issues?: { path: string; message: string }[];
  };
}

/** The "what to do next" an error carries (an `action` on an HttpException body), if any. */
export function errorAction(err: unknown): string | null {
  const r = (err as { getResponse?: () => unknown }).getResponse?.();
  const action = typeof r === 'object' && r ? (r as { action?: unknown }).action : undefined;
  return typeof action === 'string' && action ? action : null;
}
