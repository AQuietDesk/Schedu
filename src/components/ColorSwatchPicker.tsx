import { Check } from "lucide-react";
import { CLASS_COLOR_HEX, CLASS_COLOR_KEYS, type ClassColorKey } from "@/lib/classColors";
import { cn } from "@/lib/utils";

// Picks the color key stored in Context.color (a palette key, not a raw hex —
// see classColors.ts).
export function ColorSwatchPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (key: ClassColorKey | null) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Class color" className="flex flex-wrap items-center gap-2">
      {CLASS_COLOR_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={value === key}
          aria-label={key}
          onClick={() => onChange(key)}
          className={cn(
            "flex size-7 items-center justify-center rounded-full text-white transition-transform hover:scale-110",
            value === key && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
          )}
          style={{ background: CLASS_COLOR_HEX[key] }}
        >
          {value === key && <Check className="size-3.5" strokeWidth={3} />}
        </button>
      ))}
    </div>
  );
}
