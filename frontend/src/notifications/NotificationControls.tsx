import { useLayoutEffect,useRef } from 'react';
/** Mount the shared update/notification controls beside the app's existing toolbar. */
export function NotificationControls() {
 const slot=useRef<HTMLSpanElement>(null);
 useLayoutEffect(()=>{
  const element=slot.current;
  window.dispatchEvent(new CustomEvent('app-topbar-ready',{detail:element}));
  return ()=>{window.dispatchEvent(new CustomEvent('app-topbar-detach',{detail:element}));};
 },[]);
 return <span ref={slot} className="notification-controls-slot" data-app-notification-controls=""/>;
}
