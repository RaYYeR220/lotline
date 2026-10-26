import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";

const EVENT = "lotline:navigate";

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new Event(EVENT));
}

export function useLocation(): { path: string; search: URLSearchParams } {
  const read = () => ({ path: location.pathname.replace(/\/+$/, "") || "/", search: new URLSearchParams(location.search) });
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const on = () => setLoc(read());
    window.addEventListener("popstate", on);
    window.addEventListener(EVENT, on);
    return () => {
      window.removeEventListener("popstate", on);
      window.removeEventListener(EVENT, on);
    };
  }, []);
  return loc;
}

/** An anchor that routes client-side for same-origin paths and behaves normally otherwise. */
export function Link({ href = "/", onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!href.startsWith("/") || rest.target === "_blank") return;
    e.preventDefault();
    navigate(href);
    window.scrollTo(0, 0);
  };
  return <a href={href} onClick={handle} {...rest} />;
}
