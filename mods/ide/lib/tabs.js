// Pure open-file tab rules for the IDE. No host imports: covered by the Node test runner.
//
// A tab is {path, pinned, dirty}. At most one tab is unpinned: the preview tab. Opening another
// file replaces a clean preview; a preview with unsaved changes is pinned instead, then the new
// file becomes the preview.

export function openTab(tabs, path, pinned) {
  const existing = tabs.find((tab) => tab.path === path);
  if (existing) {
    if (!pinned || existing.pinned) return tabs;
    return tabs.map((tab) => (tab.path === path ? { ...tab, pinned: true } : tab));
  }

  if (pinned) return [...tabs, { path, pinned: true, dirty: false }];

  const preview = tabs.find((tab) => !tab.pinned);
  if (!preview) return [...tabs, { path, pinned: false, dirty: false }];
  if (preview.dirty) {
    return [...tabs.map((tab) => (tab === preview ? { ...tab, pinned: true } : tab)), { path, pinned: false, dirty: false }];
  }
  return tabs.map((tab) => (tab === preview ? { path, pinned: false, dirty: false } : tab));
}

export function pinTab(tabs, path) {
  return tabs.map((tab) => (tab.path === path ? { ...tab, pinned: true } : tab));
}

export function setDirty(tabs, path, dirty) {
  return tabs.map((tab) => (tab.path === path ? { ...tab, dirty } : tab));
}

export function removeTab(tabs, path) {
  return tabs.filter((tab) => tab.path !== path);
}
