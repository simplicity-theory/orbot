import { TestBed } from '@angular/core/testing';
import { StatusBadge } from './status-badge';

describe('StatusBadge', () => {
  it('shows icon and text label, never colour alone', async () => {
    const fixture = TestBed.createComponent(StatusBadge);
    fixture.componentRef.setInput('status', 'blocked');
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent?.trim()).toBe('Blocked');
    expect(el.querySelector('orb-icon svg')).toBeTruthy();
    expect(el.getAttribute('data-tone')).toBe('warning');
  });
});
