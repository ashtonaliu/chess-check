// Minimal typings for the Chrome extension APIs this extension uses.
declare namespace chrome {
  namespace runtime {
    function getURL(path: string): string;
    function reload(): void;
    function sendMessage<T = unknown>(msg: unknown): Promise<T>;
    const onMessage: {
      addListener(cb: (msg: any, sender: unknown, sendResponse: (r: unknown) => void) => boolean | void): void;
    };
    const onInstalled: { addListener(cb: () => void): void };
  }
  namespace storage {
    const local: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
    const onChanged: {
      addListener(cb: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void): void;
    } | undefined;
  }
  namespace management {
    function getSelf(): Promise<{ installType: "admin" | "development" | "normal" | "sideload" | "other" }>;
  }
  namespace tabs {
    interface Tab { id?: number; url?: string; active?: boolean }
    function sendMessage(tabId: number, msg: unknown): Promise<unknown>;
  }
  namespace action {
    const onClicked: { addListener(cb: (tab: chrome.tabs.Tab) => void): void };
  }
  namespace offscreen {
    function hasDocument(): Promise<boolean>;
    function createDocument(o: { url: string; reasons: string[]; justification: string }): Promise<void>;
  }
}

declare module "*.css" {
  const text: string;
  export default text;
}
