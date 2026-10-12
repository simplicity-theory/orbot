import { Dialog, type DialogRef } from '@angular/cdk/dialog';
import type { ComponentType } from '@angular/cdk/portal';

/** Open one of the app's dialogs with consistent styling, focus trap and Escape to close. */
export function openDialog<R, D, C>(
  dialog: Dialog,
  component: ComponentType<C>,
  data: D,
  label: string,
): DialogRef<R, C> {
  return dialog.open<R, D, C>(component, {
    data,
    panelClass: 'orb-dialog',
    backdropClass: 'orb-dialog-backdrop',
    ariaLabel: label,
    autoFocus: 'first-tabbable',
    restoreFocus: true,
  });
}
