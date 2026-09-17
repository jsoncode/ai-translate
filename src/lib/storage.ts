/**
 * chrome.storage.local 的薄封装：让 config.ts 不直接依赖 chrome，
 * 单测里可以用 vi.mock('./storage') 替换。
 */
export type StorageChangeListener = (next: unknown) => void;

export async function readConfig(): Promise<unknown> {
  const result = await chrome.storage.local.get('config');
  return result?.config;
}

export async function writeConfig(config: unknown): Promise<void> {
  await chrome.storage.local.set({ config });
}

export function onConfigChanged(listener: StorageChangeListener): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.config) return;
    listener(changes.config.newValue);
  });
}
