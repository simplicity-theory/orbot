import { Can } from '../../ui/can';
import { DIALOG_DATA, Dialog, DialogRef } from '@angular/cdk/dialog';
import { httpResource } from '@angular/common/http';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { CampaignSummary, SupplyView, TheatreDetailView } from '@orbot/shared';
import { Api, apiUrl } from '../../core/api';
import { toUserError, type UserFacingError } from '../../core/api-error';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { PageTitle } from '../../core/title';
import { openDialog } from '../../ui/dialog';
import { Icon } from '../../ui/icon';
import { LoadError } from '../../ui/load-error';
import { PhaseStepper } from '../../ui/phase-stepper';
import { Skeleton } from '../../ui/skeleton';
import { Term } from '../../ui/term';
import { Toasts } from '../../ui/toast';
import { NewCampaignDialog, type NewCampaignData } from '../campaigns/new-campaign.dialog';
import { IntentDialog } from '../operations/intent.dialog';
import { MissionChain } from '../operations/mission-chain';
import { GitHubDialog, type GitHubData } from './github.dialog';

interface CloseData {
  theatreId: string;
  name: string;
}

/** Ask why (optional), then close the theatre. Its operations must be over first. */
@Component({
  selector: 'orb-close-theatre-dialog',
  imports: [FormsModule],
  template: `
    <form class="form" (ngSubmit)="submit()">
      <h2>Close Theatre {{ data.name }}</h2>
      <p class="hint">
        A closed theatre launches nothing more; its record, repository and site stay. Operations
        still under way must close or be cancelled first.
      </p>
      <label for="close-note">Why (optional)</label>
      <input id="close-note" name="note" class="input" [(ngModel)]="note" placeholder="Shipped" />
      @if (error(); as e) {
        <p role="alert" class="error">{{ e.message }} {{ e.action }}</p>
      }
      <div class="actions">
        <button type="button" class="btn btn--ghost" (click)="ref.close()">Keep it open</button>
        <button type="submit" class="btn btn--primary" [disabled]="busy()">Close theatre</button>
      </div>
    </form>
  `,
  styles: `
    .error {
      color: var(--tone-danger);
    }
  `,
})
export class CloseTheatreDialog {
  protected readonly data = inject<CloseData>(DIALOG_DATA);
  protected readonly ref = inject(DialogRef);
  private readonly api = inject(Api);
  protected note = '';
  protected readonly busy = signal(false);
  protected readonly error = signal<UserFacingError | null>(null);

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.closeTheatre(this.data.theatreId, this.note.trim());
      this.ref.close(true);
    } catch (err) {
      this.error.set(toUserError(err));
    } finally {
      this.busy.set(false);
    }
  }
}

/** One theatre: its repository and site, what it holds, and the operations run in it. */
@Component({
  selector: 'orb-theatre-page',
  imports: [
    Can,
    FormsModule,
    RouterLink,
    Icon,
    LoadError,
    PhaseStepper,
    Skeleton,
    Term,
    MissionChain,
  ],
  template: `
    @if (view.error(); as err) {
      <div class="page"><orb-load-error [error]="err" (retry)="view.reload()" /></div>
    } @else if (view.hasValue()) {
      @let v = view.value();
      <div class="page">
        <header class="page-header">
          <div>
            <p class="page-header__eyebrow">
              <orb-term key="theatre">Theatre</orb-term> · {{ v.theatre.status }}
            </p>
            <h1>Theatre {{ v.theatre.name }}</h1>
            @if (v.theatre.description) {
              <p class="page-header__lede">{{ v.theatre.description }}</p>
            }
            @if (v.theatre.closed; as c) {
              <p class="meta">Closed{{ c.note ? ': ' + c.note : '' }}</p>
            }
          </div>
          <div class="header-actions">
            @if (v.site?.published) {
              <a class="btn btn--primary" [href]="v.site!.url" target="_blank" rel="noopener">
                <orb-icon name="link" /> Open the app
              </a>
            }
            @if (v.github; as gh) {
              <a class="btn" [href]="gh.url" target="_blank" rel="noopener">
                <orb-icon name="git-branch" /> On GitHub: {{ gh.owner }}/{{ gh.repo }}
              </a>
            } @else if (v.theatre.status === 'open' && v.theatre.repoSupplyId) {
              <button type="button" class="btn" *orbCan="null" (click)="github()">
                <orb-icon name="git-branch" /> Put on GitHub…
              </button>
            }
          </div>
          @if (v.theatre.status === 'open') {
            <div class="header-actions" *orbCan="null">
              <button type="button" class="btn" (click)="closeTheatre()">
                <orb-icon name="x" /> Close theatre…
              </button>
              <button type="button" class="btn" (click)="planCampaign()">Plan a campaign…</button>
              <button type="button" class="btn" (click)="stateIntent()">State intent</button>
            </div>
          }
        </header>
        @if (v.theatre.autonomy === 'full') {
          <p class="meta">
            Fully automatic: plans are approved for you, nothing holds on a finding, and finished
            work lands on {{ v.repository?.name ?? 'the repository'
            }}{{ v.site ? ' and is published to ' + v.site.name : '' }}.
          </p>
        }

        <section class="panel" aria-labelledby="th-res-h">
          <h2 id="th-res-h" class="panel__title">What the theatre holds</h2>
          <p class="hint">
            Every operation launched here starts with all of it. The first repository is where the
            work lands.
          </p>
          <ul class="list-reset held" aria-label="Theatre resources">
            @for (s of v.resources; track s.id) {
              <li class="chip" [class.main]="s.id === v.theatre.repoSupplyId">
                <span class="kind">{{ kindOf(s) }}</span>
                @if (s.spec.kind === 'environment' && s.spec.site && siteUrl(s); as url) {
                  <a [href]="url" target="_blank" rel="noopener">{{ s.name }}</a>
                } @else {
                  {{ s.name }}
                }
                @if (s.id === v.theatre.repoSupplyId) {
                  <span class="tag">main</span>
                }
                <ng-container *orbCan="null">
                  @if (s.spec.kind === 'repository' && s.id !== v.theatre.repoSupplyId) {
                    <button
                      type="button"
                      class="btn btn--ghost small"
                      [disabled]="busy()"
                      [attr.aria-label]="'Make ' + s.name + ' the main repository'"
                      (click)="makeMain(s.id)"
                    >
                      Make main
                    </button>
                  }
                  <button
                    type="button"
                    class="btn btn--ghost small"
                    [disabled]="busy()"
                    [attr.aria-label]="'Take ' + s.name + ' off the theatre'"
                    (click)="release(s.id)"
                  >
                    <orb-icon class="sm" name="x" />
                  </button>
                </ng-container>
              </li>
            } @empty {
              <li class="meta">Nothing yet: assign a repository below.</li>
            }
          </ul>
          @if (v.theatre.status === 'open' && depot.value(); as list) {
            <form class="assign" *orbCan="null" (ngSubmit)="assign()">
              <label for="th-assign">Resource to assign</label>
              <select id="th-assign" name="assign" class="input" [(ngModel)]="toAssign">
                <option value="">Assign from the Supply Depot…</option>
                @for (s of assignable(list, v.resources); track s.id) {
                  <option [value]="s.id">{{ s.name }} ({{ kindOf(s) }})</option>
                }
              </select>
              <button type="submit" class="btn" [disabled]="busy() || !toAssign">Assign</button>
            </form>
          }
        </section>

        @if (v.campaigns.length) {
          <section class="panel" aria-labelledby="th-camp-h">
            <h2 id="th-camp-h" class="panel__title">
              <orb-term key="campaign">Campaigns</orb-term>
            </h2>
            <ul class="list-reset campaigns" aria-label="Campaigns in this theatre">
              @for (c of v.campaigns; track c.campaign.id) {
                <li class="campaign">
                  <h3>
                    <a [routerLink]="['/campaigns', c.campaign.id]"
                      >Campaign {{ c.campaign.name }}</a
                    >
                  </h3>
                  <span class="meta">
                    {{ c.campaign.status }} · {{ doneSteps(c) }} of {{ c.steps.length }} step(s)
                    done
                  </span>
                  @if (c.needsYou.length) {
                    <a class="needs" [routerLink]="['/campaigns', c.campaign.id]"
                      >{{ c.needsYou.length }} need you</a
                    >
                  }
                  <ol class="list-reset chips" aria-label="Steps">
                    @for (s of c.steps; track s.index) {
                      <li
                        class="chip"
                        [class.main]="s.status === 'under-way' || s.status === 'held'"
                      >
                        {{ s.index + 1 }}. {{ s.name }}
                        <span class="kind">{{ s.status }}</span>
                      </li>
                    }
                  </ol>
                </li>
              }
            </ul>
          </section>
        }

        <section class="panel" aria-labelledby="th-ops-h">
          <h2 id="th-ops-h" class="panel__title">
            <orb-term key="operation">Operations</orb-term> in this theatre
          </h2>
          <ul class="list-reset ops">
            @for (o of v.operations; track o.operation.id) {
              <li class="op">
                <header>
                  <h3>
                    <a [routerLink]="['/operations', o.operation.id]"
                      >Operation {{ o.operation.name }}</a
                    >
                  </h3>
                  @if (o.needsYou.length) {
                    <a class="needs" [routerLink]="['/operations', o.operation.id]"
                      >{{ o.needsYou.length }} need you</a
                    >
                  }
                </header>
                <p class="meta">
                  <orb-term key="intent">Intent</orb-term>: {{ o.operation.intent }}
                </p>
                <orb-phase-stepper [phase]="o.operation.phase" [compact]="true" />
                @if (o.missions.length) {
                  <orb-mission-chain [missions]="o.missions" />
                }
              </li>
            } @empty {
              <li class="meta">
                No operation yet. State your intent: HQ plans it with everything the theatre holds.
              </li>
            }
          </ul>
        </section>
      </div>
    } @else {
      <div class="page" aria-busy="true">
        <orb-skeleton [lines]="2" />
        <orb-skeleton variant="block" [lines]="2" />
      </div>
    }
  `,
  styles: `
    .header-actions {
      display: flex;
      gap: var(--space-2);
    }
    .held {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-top: var(--space-3);
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      &.main {
        border-color: var(--color-accent);
      }
    }
    .kind,
    .tag {
      font-size: var(--font-size-xs);
      letter-spacing: var(--letter-spacing-caps);
      text-transform: uppercase;
      color: var(--color-text-muted);
    }
    .tag {
      color: var(--color-accent);
    }
    .assign {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: var(--space-2);
      margin-top: var(--space-4);
      label {
        flex-basis: 100%;
      }
      select {
        flex: 1 1 var(--card-min-width);
      }
    }
    .ops {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .op {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      padding-top: var(--space-3);
      border-top: var(--border-width) solid var(--color-border);
      header {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
      }
      h3 {
        margin: 0 auto 0 0;
        font-size: var(--font-size-md);
      }
    }
    .needs {
      color: var(--tone-warning);
      font-weight: var(--font-weight-semibold);
    }
    .campaigns {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .campaign {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--space-3);
      h3 {
        margin: 0;
        font-size: var(--font-size-md);
      }
    }
    .chips {
      flex-basis: 100%;
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
  `,
})
export class TheatrePage {
  readonly theatreId = input.required<string>();
  protected readonly view = httpResource<TheatreDetailView>(() => apiUrl.theatre(this.theatreId()));
  protected readonly depot = httpResource<SupplyView[]>(() => apiUrl.supply());
  private readonly api = inject(Api);
  private readonly dialog = inject(Dialog);
  private readonly toasts = inject(Toasts);
  protected readonly busy = signal(false);
  protected toAssign = '';

  protected readonly name = computed(() => this.view.value()?.theatre.name ?? '');

  constructor() {
    const crumbs = inject(Breadcrumbs);
    const title = inject(PageTitle);
    effect(() => {
      const v = this.view.value();
      if (!v) return;
      crumbs.set([
        ORBAT_CRUMB,
        { label: 'Theatres', link: '/theatres', term: 'theatre' },
        { label: `Theatre ${v.theatre.name}` },
      ]);
      title.set(`Theatre ${v.theatre.name}`);
    });
    reloadOnLive(
      (n) =>
        n.type === 'version' &&
        ['theatre', 'campaign', 'operation', 'mission', 'task', 'supply'].includes(
          n.version.entityType,
        ),
      () => this.view.reload(),
    );
  }

  protected kindOf(s: SupplyView): string {
    if (s.spec.kind === 'environment') return s.spec.site ? 'static site' : 'environment';
    return s.spec.kind;
  }

  protected siteUrl(s: SupplyView): string | null {
    return s.spec.kind === 'environment' && s.spec.site ? `/api/sites/${s.id}/` : null;
  }

  protected assignable(list: SupplyView[], held: SupplyView[]): SupplyView[] {
    const have = new Set(held.map((s) => s.id));
    return list.filter((s) => s.connected && !have.has(s.id) && s.spec.kind !== 'connection');
  }

  protected doneSteps(c: CampaignSummary): number {
    return c.steps.filter((s) => s.status === 'done').length;
  }

  protected planCampaign(): void {
    const v = this.view.value();
    if (!v) return;
    openDialog<void, NewCampaignData, NewCampaignDialog>(
      this.dialog,
      NewCampaignDialog,
      { theatreId: v.theatre.id, theatreName: v.theatre.name },
      'Plan a campaign',
    );
  }

  protected github(): void {
    const v = this.view.value();
    if (!v) return;
    openDialog<string | boolean | undefined, GitHubData, GitHubDialog>(
      this.dialog,
      GitHubDialog,
      { theatreId: v.theatre.id, name: v.theatre.name },
      `Put Theatre ${v.theatre.name} on GitHub`,
    ).closed.subscribe((done) => {
      if (!done) return;
      this.toasts.show({
        tone: 'success',
        message: `Theatre ${v.theatre.name} is on GitHub; main pushed, and every landing follows.`,
        detail: typeof done === 'string' ? done : undefined,
      });
      this.view.reload();
    });
  }

  protected stateIntent(): void {
    const v = this.view.value();
    if (!v) return;
    openDialog(
      this.dialog,
      IntentDialog,
      { theatreId: v.theatre.id, theatreName: v.theatre.name, hasRepo: !!v.theatre.repoSupplyId },
      'State your intent',
    );
  }

  protected closeTheatre(): void {
    const v = this.view.value();
    if (!v) return;
    openDialog<boolean, CloseData, CloseTheatreDialog>(
      this.dialog,
      CloseTheatreDialog,
      { theatreId: v.theatre.id, name: v.theatre.name },
      `Close Theatre ${v.theatre.name}`,
    ).closed.subscribe((done) => {
      if (!done) return;
      this.toasts.show({ tone: 'info', message: `Theatre ${v.theatre.name} closed.` });
      this.view.reload();
    });
  }

  protected async assign(): Promise<void> {
    if (!this.toAssign) return;
    await this.run(() => this.api.assignToTheatre(this.theatreId(), this.toAssign), 'Assigned.');
    this.toAssign = '';
  }

  protected async release(supplyId: string): Promise<void> {
    await this.run(() => this.api.releaseFromTheatre(this.theatreId(), supplyId), 'Taken off.');
  }

  protected async makeMain(supplyId: string): Promise<void> {
    await this.run(
      () => this.api.setTheatreMainRepository(this.theatreId(), supplyId),
      'Main repository changed.',
    );
  }

  private async run(fn: () => Promise<unknown>, done: string): Promise<void> {
    this.busy.set(true);
    try {
      await fn();
      this.view.reload();
      this.toasts.show({ tone: 'success', message: done });
    } catch (err) {
      const e = toUserError(err);
      this.toasts.show({ tone: 'danger', message: e.message, detail: e.action });
    } finally {
      this.busy.set(false);
    }
  }
}
