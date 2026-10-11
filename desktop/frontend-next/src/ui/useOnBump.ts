import { useEffect, useRef } from "react";

/** Runs `fn` when `count` changes after mount. A counter is how a request made
 *  twice stays two requests, and mounting is not one. */
export function useOnBump(count: number, fn: () => void): void {
  const seen = useRef(count);
  useEffect(() => {
    if (seen.current === count) return;
    seen.current = count;
    fn();
  }, [count]);
}
