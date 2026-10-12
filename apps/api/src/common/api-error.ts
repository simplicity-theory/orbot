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
