// Minimal typings for the Chrome extension APIs this extension uses.
declare namespace chrome {
  namespace runtime {
    function getURL(path: string): string;
    const onInstalled: { addListener(cb: () => void): void };
  }
  namespace storage {
    const local: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  }
  namespace tabs {
    interface Tab { id?: number; url?: string; active?: boolean }
    function query(q: { active: boolean; currentWindow?: boolean; lastFocusedWindow?: boolean }): Promise<Tab[]>;
    function get(id: number): Promise<Tab>;
    const onActivated: { addListener(cb: (info: { tabId: number }) => void): void };
    const onUpdated: { addListener(cb: (tabId: number, change: { url?: string; status?: string }, tab: Tab) => void): void };
  }
  namespace sidePanel {
    function setPanelBehavior(o: { openPanelOnActionClick: boolean }): Promise<void>;
  }
}
