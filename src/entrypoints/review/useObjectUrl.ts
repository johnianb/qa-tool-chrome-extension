import { useEffect, useState } from 'react';

/**
 * Blob → object URL, revoked when the blob changes or the component unmounts.
 *
 * The `instanceof` check is load-bearing, not defensive noise. A session written by an
 * older build can hold `{}` where a Blob belongs (a Blob does not survive
 * `chrome.runtime.sendMessage`, which serialises as JSON). `URL.createObjectURL({})`
 * throws, and a throw inside an effect unmounts the React root — one bad record would
 * otherwise blank the whole page.
 */
export function useObjectUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!(blob instanceof Blob) || blob.size === 0) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}
