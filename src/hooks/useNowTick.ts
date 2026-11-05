import { useEffect, useState } from "react";

// Ticks on an interval so a "now" indicator (Calendar week view's now-line,
// the Day Ring's live clock/now-line) keeps drifting forward while the app
// sits open, instead of freezing at mount time.
export function useNowTick(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
