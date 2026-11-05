import { useState } from "react";
import { formatFocusDuration } from "@/lib/focusStatistics";
import { useFocusStore } from "@/store/focusStore";
import type { FocusOutcome, FocusSession } from "@/types";

// Shown the moment a focus phase ends, overlapping with the break that's
// already started — closes the intent → outcome loop in a few seconds
// without blocking anything: skipping just leaves the backend's default
// outcome ('completed') in place.
export function FocusReflection({ session, onDone }: { session: FocusSession; onDone: () => void }) {
  const submitReflection = useFocusStore((s) => s.submitReflection);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const choose = async (outcome: FocusOutcome) => {
    setSubmitting(true);
    try {
      await submitReflection(outcome, note.trim() || null);
    } finally {
      setSubmitting(false);
      onDone();
    }
  };

  const option = "h-9 flex-1 rounded-lg border border-line2 text-sm transition-colors hover:bg-hover disabled:opacity-50";

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-line bg-card p-5">
      <div>
        <h2 className="text-[15px] font-semibold">Nice — {formatFocusDuration(session.actual_duration_seconds ?? 0)} on “{session.intent}”</h2>
        <p className="mt-1 text-sm text-fg2">{session.goal ? `Did you get “${session.goal}” done?` : "Did you get what you wanted done?"}</p>
      </div>
      <div className="flex gap-2">
        <button type="button" className={option} disabled={submitting} onClick={() => void choose("completed")}>
          Yes
        </button>
        <button type="button" className={option} disabled={submitting} onClick={() => void choose("partial")}>
          Partly
        </button>
        <button type="button" className={option} disabled={submitting} onClick={() => void choose("not_completed")}>
          Not yet
        </button>
      </div>
      <input
        aria-label="Optional note"
        placeholder="Optional note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="h-10 rounded-lg bg-sunken px-3 text-sm outline-none focus:ring-2 focus:ring-ring/40"
      />
      <button type="button" className="self-start text-[13px] text-fg3 hover:text-fg2" onClick={onDone}>
        Skip
      </button>
    </section>
  );
}
