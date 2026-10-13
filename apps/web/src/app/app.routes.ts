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
          import('./features/operations/operations.page').then((m) => m.OperationsPage),
      },
      {
        path: 'connections',
        title: 'Connections',
        loadComponent: () =>
          import('./features/connections/connections.page').then((m) => m.ConnectionsPage),
      },
      {
        path: 'officers',
        title: 'Officers',
        loadComponent: () =>
          import('./features/officers/officers.page').then((m) => m.OfficersPage),
      },
      {
        path: 'brief',
        title: 'Daily brief',
        loadComponent: () => import('./features/brief/brief.page').then((m) => m.BriefPage),
      },
      {
        path: 'disputes',
        title: 'Disputes',
        loadComponent: () =>
          import('./features/disputes/disputes.page').then((m) => m.DisputesPage),
      },
      {
        path: 'deconfliction',
        title: 'Deconfliction',
        loadComponent: () =>
          import('./features/deconfliction/deconfliction.page').then((m) => m.DeconflictionPage),
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
      {
        path: 'operations/:operationId',
        loadComponent: () =>
          import('./features/operations/operation.page').then((m) => m.OperationPage),
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
