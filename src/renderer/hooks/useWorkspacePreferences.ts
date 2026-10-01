import React from 'react';
export function useWorkspacePreferences<T extends boolean | number>(key: string, fallback: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = React.useState<T>(() => {
    try { const stored: unknown = JSON.parse(localStorage.getItem(`ade.layout.${key}`) ?? 'null'); return typeof stored === typeof fallback ? stored as T : fallback; }
    catch { return fallback; }
  });
  React.useEffect(() => { try { localStorage.setItem(`ade.layout.${key}`, JSON.stringify(value)); } catch { /* preferences are optional */ } }, [key, value]);
  return [value, setValue];
}
