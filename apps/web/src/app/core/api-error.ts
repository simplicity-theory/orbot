import { HttpErrorResponse } from '@angular/common/http';

/** What went wrong and what to do about it, in plain language. Never a stack trace. */
export interface UserFacingError {
  message: string;
  action: string;
  ref?: string;
}

export function toUserError(err: unknown): UserFacingError {
  if (err instanceof HttpErrorResponse) {
    const body = err.error as { error?: Partial<UserFacingError> } | null;
    if (body?.error?.message) {
      return {
        message: body.error.message,
        action: body.error.action ?? 'Try again in a moment.',
        ...(body.error.ref ? { ref: body.error.ref } : {}),
      };
    }
    if (err.status === 0) {
      return {
        message: 'Cannot reach the ORBOT API.',
        action:
          'Check that the API is running (npm run dev) and your connection is up, then retry.',
      };
    }
    return { message: `The server answered ${err.status}.`, action: 'Try again in a moment.' };
  }
  return { message: 'Something unexpected went wrong in the browser.', action: 'Reload the page.' };
}
