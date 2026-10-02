/**
 * Reads the extra tabs embedded into index.html by the reporter or the CLI.
 * See src/shared/tabsFormat.ts for the format.
 */

import type { ExtendedTab, ExtendedTabsPayload } from '../../../src/shared/tabsFormat';
import { kTabsTemplateId, sortTabs, validateTab } from '../../../src/shared/tabsFormat';

export type { ExtendedTab } from '../../../src/shared/tabsFormat';

let cachedTabs: ExtendedTab[] | undefined;

export function extendedTabs(): ExtendedTab[] {
  if (!cachedTabs)
    cachedTabs = loadTabs();
  return cachedTabs;
}

export function findExtendedTab(id: string | null): ExtendedTab | undefined {
  if (id === null)
    return undefined;
  return extendedTabs().find(tab => tab.id === id);
}

function loadTabs(): ExtendedTab[] {
  const template = document.getElementById(kTabsTemplateId) as HTMLTemplateElement | null;
  const base64 = template?.content?.textContent?.trim() || template?.textContent?.trim();
  if (!base64)
    return [];
  try {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as ExtendedTabsPayload;
    const tabs: ExtendedTab[] = [];
    for (const tab of payload.tabs || []) {
      const error = validateTab(tab);
      if (error)
        console.warn(`[extended-report] skipping tab: ${error}`);
      else
        tabs.push(tab);
    }
    return sortTabs(tabs);
  } catch (e) {
    console.error('[extended-report] failed to read extra tabs', e);
    return [];
  }
}
