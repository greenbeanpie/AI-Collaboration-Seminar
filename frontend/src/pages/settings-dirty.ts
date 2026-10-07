import { createContext, useCallback, useContext, useEffect, useId } from 'react';
import { setDesktopDirty } from '../desktop/lifecycle';
export const SettingsDirtyContext = createContext<(id: string, dirty: boolean) => void>(() => {});
export function useSettingsDirty(dirty: boolean) {
  const setDirty = useContext(SettingsDirtyContext);
  const id = useId();
  useEffect(() => { setDirty(id, dirty); setDesktopDirty(id, dirty); return () => { setDirty(id, false); setDesktopDirty(id, false); }; }, [id, dirty, setDirty]);
  return useCallback(() => { setDirty(id, false); setDesktopDirty(id, false); }, [id, setDirty]);
}
