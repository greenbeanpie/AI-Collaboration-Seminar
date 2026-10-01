import { createContext, useCallback, useContext, useEffect, useId } from 'react';
export const SettingsDirtyContext = createContext<(id: string, dirty: boolean) => void>(() => {});
export function useSettingsDirty(dirty: boolean) {
  const setDirty = useContext(SettingsDirtyContext);
  const id = useId();
  useEffect(() => { setDirty(id, dirty); return () => setDirty(id, false); }, [id, dirty, setDirty]);
  return useCallback(() => setDirty(id, false), [id, setDirty]);
}
