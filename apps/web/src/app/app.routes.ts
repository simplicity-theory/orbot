import type { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';

/**
 * Every object has a stable, deep-linkable URL that mirrors the chain of command:
 *   /units/:unitId/bots/:botId/tasks/:taskId
 */
export const routes: Routes = [
  {
    path: 'login',
    title: 'Sign in',
    loadComponent: () => import('./features/login/login.page').then((m) => m.LoginPage),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./shell/shell').then((m) => m.Shell),
    children: [
      {
        path: '',
        pathMatch: 'full',
        title: 'ORBAT',
        loadComponent: () => import('./features/orbat/orbat.page').then((m) => m.OrbatPage),
      },
      {
        path: 'units/:unitId',
        loadComponent: () => import('./features/units/unit.page').then((m) => m.UnitPage),
      },
      {
        path: 'units/:unitId/documents/:documentId',
        loadComponent: () =>
          import('./features/documents/document.page').then((m) => m.DocumentPage),
      },
      {
        path: 'units/:unitId/bots/:botId',
        loadComponent: () => import('./features/bots/bot.page').then((m) => m.BotPage),
      },
      {
        path: 'units/:unitId/bots/:botId/tasks/:taskId',
        loadComponent: () => import('./features/tasks/task.page').then((m) => m.TaskPage),
      },
      {
        path: 'units/:unitId/tasks/:taskId',
        loadComponent: () => import('./features/tasks/task.page').then((m) => m.TaskPage),
      },
      {
        path: 'operations',
        title: 'Operations',
        loadComponent: () =>
          import('./features/placeholder/operations.page').then((m) => m.OperationsPage),
      },
      {
        path: 'approvals',
        title: 'Approvals',
        loadComponent: () =>
          import('./features/placeholder/approvals.page').then((m) => m.ApprovalsPage),
      },
      {
        path: 'sitreps',
        title: 'Sitreps',
        loadComponent: () =>
          import('./features/placeholder/sitreps.page').then((m) => m.SitrepsPage),
      },
      { path: 'chat', pathMatch: 'full', redirectTo: 'chat/hq' },
      {
        path: 'chat/:channel',
        loadComponent: () => import('./features/chat/chat.page').then((m) => m.ChatPage),
      },
      {
        path: 'orders',
        title: 'Orders log',
        loadComponent: () => import('./features/orders/orders.page').then((m) => m.OrdersPage),
      },
      {
        path: 'supply',
        title: 'Supply Depot',
        loadComponent: () => import('./features/supply/supply.page').then((m) => m.SupplyPage),
      },
      {
        path: 'archive',
        title: 'Archive',
        loadComponent: () => import('./features/archive/archive.page').then((m) => m.ArchivePage),
      },
      {
        path: 'archive/:entityId',
        loadComponent: () => import('./features/archive/history.page').then((m) => m.HistoryPage),
      },
      {
        path: 'settings',
        title: 'Settings',
        loadComponent: () =>
          import('./features/settings/settings.page').then((m) => m.SettingsPage),
      },
      {
        path: '**',
        title: 'Not found',
        loadComponent: () =>
          import('./features/placeholder/not-found.page').then((m) => m.NotFoundPage),
      },
    ],
  },
];
