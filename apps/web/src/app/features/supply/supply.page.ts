import { Dialog } from '@angular/cdk/dialog';
import type { ComponentType } from '@angular/cdk/portal';
import { httpResource } from '@angular/common/http';
import { Component, computed, effect, inject, input, type OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { SupplyView, UnitView } from '@orbot/shared';
import { apiUrl } from '../../core/api';
import { Breadcrumbs, ORBAT_CRUMB } from '../../core/breadcrumbs';
import { reloadOnLive } from '../../core/live';
import { PageTitle } from '../../core/title';
import { Can } from '../../ui/can';
import { openDialog } from '../../ui/dialog';
import { EmptyState } from '../../ui/empty-state';
import { Icon } from '../../ui/icon';
import { LoadError } from '../../ui/load-error';
import { Skeleton } from '../../ui/skeleton';
import { Term } from '../../ui/term';
import { ConnectionDialog, type ConnectionDialogData } from './connection.dialog';
import { CredentialDialog, type CredentialDialogData } from './credential.dialog';
import { EnvironmentDialog, type EnvironmentDialogData } from './environment.dialog';
import { RepositoryDialog, type RepositoryDialogData } from './repository.dialog';
import { SupplyItem } from './supply-item';
import { parseWanted, sectionOf, SUPPLY_SECTIONS, type SupplySection } from './supply-sections';

/** Only what the Commander has connected exists. Connect it here, then issue it to units. */
@Component({
  selector: 'orb-supply-page',
  imports: [Can, RouterLink, EmptyState, Icon, LoadError, Skeleton, Term, SupplyItem],
  template: `
    <div class="page page--detail">
      <header class="page-header">
        <div>
          <h1><orb-term key="supply-depot">Supply Depot</orb-term></h1>
          <p class="page-header__lede">
            Everything you have connected. Units can only use what is issued to them.
          </p>
        </div>
      </header>

      @if (connect(); as wanted) {
        <div class="panel notice" role="status">
          <orb-icon name="info" />
          <span
            >An Overseer asked for <strong>{{ wanted }}</strong
            >, which is not connected yet. Connect it, then issue it in chat or here.</span
          >
          <button *orbCan="null" type="button" class="btn" (click)="openWanted()">
            Connect {{ wanted }}…
          </button>
        </div>
      }

      <nav class="sections" aria-label="Supply Depot sections">
        @for (sec of sections; track sec.id) {
          <a
            [routerLink]="[]"
            [queryParams]="{ section: sec.id === 'repositories' ? null : sec.id, connect: null }"
            [attr.aria-current]="current() === sec.id ? 'page' : null"
          >
            <orb-icon class="sm" [name]="sec.icon" />
            {{ sec.label }}
            @if (supply.hasValue()) {
              <span class="count">{{ counts()[sec.id] }}</span>
            }
          </a>
        }
      </nav>

      @let sec = active();
      <section class="stock" aria-labelledby="stock-h">
        <div class="stock__head">
          <div>
            <h2 id="stock-h">
              @if (sec.id === 'connections') {
                <orb-term key="connection">{{ sec.label }}</orb-term>
              } @else {
                {{ sec.label }}
              }
            </h2>
            <p class="meta">{{ sec.lede }}</p>
          </div>
          <button *orbCan="null" type="button" class="btn btn--primary" (click)="add()">
            <orb-icon class="sm" name="plus" />
            {{ sec.add }}
          </button>
        </div>

        @if (supply.error(); as err) {
          <orb-load-error [error]="err" (retry)="supply.reload()" />
        } @else if (supply.hasValue()) {
          @if (items().length) {
            <ul class="list-reset items" [attr.aria-label]="sec.label">
              @for (s of items(); track s.id) {
                <li>
                  <orb-supply-item
                    [item]="s"
                    [units]="units()"
                    [repoName]="repoName(s)"
                    (changed)="reload()"
                  />
                </li>
              }
            </ul>
          } @else {
            <orb-empty-state [icon]="sec.icon" [title]="sec.empty">
              {{ sec.emptyBody }}
              <button *orbCan="null" actions type="button" class="btn btn--primary" (click)="add()">
                {{ sec.add }}
              </button>
            </orb-empty-state>
          }
        } @else {
          <orb-skeleton variant="block" [lines]="3" />
        }
      </section>
    </div>
  `,
  styles: `
    .notice {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      border-color: var(--tone-warning);
      span {
        flex: 1;
      }
    }
    .stock {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .stock__head {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-3);
      h2 {
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-semibold);
      }
      .meta {
        margin-top: var(--space-1);
      }
    }
    .items {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
  `,
})
export class SupplyPage implements OnInit {
  private readonly dialog = inject(Dialog);
  /** `?section=` — every section is deep-linkable. */
  readonly section = input<SupplySection | null, string | undefined>(null, {
    transform: (v) => (SUPPLY_SECTIONS.some((s) => s.id === v) ? (v as SupplySection) : null),
  });
  /** `?connect=` — what an Overseer said was missing. */
  readonly connect = input<string>();
  protected readonly sections = SUPPLY_SECTIONS;
  protected readonly supply = httpResource<SupplyView[]>(() => apiUrl.supply());
  private readonly unitList = httpResource<UnitView[]>(() => apiUrl.units());
  protected readonly units = computed(() => this.unitList.value() ?? []);

  /** The section asked for, else the one for what an Overseer wanted, else repositories. */
  protected readonly current = computed<SupplySection>(() => {
    const wanted = this.connect();
    return this.section() ?? (wanted ? parseWanted(wanted).section : 'repositories');
  });
  protected readonly active = computed(() => SUPPLY_SECTIONS.find((s) => s.id === this.current())!);
  protected readonly items = computed(() =>
    (this.supply.value() ?? []).filter((s) => sectionOf(s) === this.current()),
  );
  protected readonly counts = computed(() => {
    const counts = Object.fromEntries(SUPPLY_SECTIONS.map((s) => [s.id, 0])) as Record<
      SupplySection,
      number
    >;
    for (const s of this.supply.value() ?? []) counts[sectionOf(s)]++;
    return counts;
  });
  private readonly repositories = computed(() =>
    (this.supply.value() ?? []).filter((s) => s.spec.kind === 'repository' && s.connected),
  );
  private readonly credentials = computed(() =>
    (this.supply.value() ?? []).flatMap((s) =>
      s.spec.kind === 'credential' && s.connected ? [s.spec.secretName] : [],
    ),
  );

  constructor() {
    const crumbs = inject(Breadcrumbs);
    const title = inject(PageTitle);
    effect(() => {
      const sec = this.active();
      crumbs.set([
        ORBAT_CRUMB,
        { label: 'Supply Depot', term: 'supply-depot', link: '/supply' },
        { label: sec.label },
      ]);
      title.set(`${sec.label} · Supply Depot`);
    });
    reloadOnLive(
      (n) =>
        n.type === 'version' &&
        (n.version.entityType === 'supply' || n.version.entityType === 'unit'),
      () => this.reload(),
    );
  }

  ngOnInit(): void {
    // Arriving from a read-back that named something missing: go straight to its form.
    if (this.connect()) this.openWanted();
  }

  protected reload(): void {
    this.supply.reload();
    this.unitList.reload();
  }

  protected repoName(s: SupplyView): string | null {
    if (s.spec.kind !== 'connection') return null;
    const id = s.spec.repoSupplyId;
    return (this.supply.value() ?? []).find((r) => r.id === id)?.name ?? null;
  }

  protected openWanted(): void {
    const { section, name } = parseWanted(this.connect() ?? '');
    this.open(section, name);
  }

  protected add(): void {
    this.open(this.current());
  }

  private open(section: SupplySection, name?: string): void {
    const sec = SUPPLY_SECTIONS.find((s) => s.id === section)!;
    const ref = (() => {
      switch (section) {
        case 'repositories':
          return this.show<RepositoryDialogData>(RepositoryDialog, { name }, sec.add);
        case 'credentials':
          return this.show<CredentialDialogData>(CredentialDialog, { name }, sec.add);
        case 'environments':
          return this.show<EnvironmentDialogData>(
            EnvironmentDialog,
            { name, credentials: this.credentials },
            sec.add,
          );
        case 'connections':
          return this.show<ConnectionDialogData>(
            ConnectionDialog,
            {
              repositories: computed(() =>
                this.repositories().map((r) => ({ id: r.id, name: r.name })),
              ),
              credentials: this.credentials,
            },
            sec.add,
          );
      }
    })();
    ref.closed.subscribe((s) => {
      if (s) this.reload();
    });
  }

  private show<D>(component: ComponentType<unknown>, data: D, label: string) {
    return openDialog<SupplyView, D, unknown>(this.dialog, component, data, label);
  }
}
