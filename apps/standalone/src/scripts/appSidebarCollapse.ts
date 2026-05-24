// Pure helpers for the AppSidebar collapse state machine. The Astro
// component's bundled <script> imports these and wires them to the
// real window.localStorage / window.matchMedia at runtime. Keeping
// the logic here makes it unit-testable without JSDOM.

export const STORAGE_KEY = 'chat-arch:sidebar-collapsed';
export const MOBILE_MEDIA = '(max-width: 899px)';

export function readStoredCollapsed(storage: Storage): boolean {
  try {
    return storage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeStoredCollapsed(storage: Storage, collapsed: boolean): void {
  try {
    storage.setItem(STORAGE_KEY, collapsed ? 'true' : 'false');
  } catch {
    // Policy-locked / quota-exceeded storage — accept the loss.
  }
}

export interface InitialCollapsedInput {
  stored: boolean;
  mobile: boolean;
}

// Mobile viewport forces collapsed regardless of stored preference;
// otherwise the stored value wins. The user can still toggle open at
// narrow widths — but on first paint we default to icon-strip so the
// page content isn't pushed off-screen.
export function initialCollapsedFor({ stored, mobile }: InitialCollapsedInput): boolean {
  if (mobile) return true;
  return stored;
}

// Bound to a sidebar root element at runtime. Exposes the imperative
// hooks the inline script needs.
export interface CollapseController {
  set(collapsed: boolean, opts?: { persist?: boolean }): void;
  toggle(): void;
  current(): boolean;
}

export function attachCollapse(
  root: HTMLElement,
  storage: Storage,
  toggleBtn: HTMLElement | null,
): CollapseController {
  let collapsed = root.getAttribute('data-collapsed') === 'true';
  const apply = (next: boolean, persist: boolean): void => {
    collapsed = next;
    root.setAttribute('data-collapsed', next ? 'true' : 'false');
    if (toggleBtn !== null) {
      toggleBtn.setAttribute('aria-expanded', next ? 'false' : 'true');
    }
    if (persist) writeStoredCollapsed(storage, next);
  };
  return {
    set: (c, opts) => apply(c, opts?.persist !== false),
    toggle: () => apply(!collapsed, true),
    current: () => collapsed,
  };
}
