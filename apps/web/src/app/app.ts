import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastOutlet } from './ui/toast';

@Component({
  selector: 'orb-root',
  imports: [RouterOutlet, ToastOutlet],
  template: `<router-outlet /><orb-toast-outlet />`,
})
export class App {}
