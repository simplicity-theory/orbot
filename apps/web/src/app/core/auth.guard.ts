import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { Auth } from './auth';
import { Live } from './live';

/** Signed-out users go to the sign-in page and come back afterwards. */
export const authGuard: CanActivateFn = async (_route, state) => {
  // Inject before any await: injection context ends at the first suspension.
  const auth = inject(Auth);
  const router = inject(Router);
  const live = inject(Live);
  const principal =
    auth.principal() === undefined ? await auth.check().catch(() => null) : auth.principal();
  if (principal) {
    live.connect();
    return true;
  }
  return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};
