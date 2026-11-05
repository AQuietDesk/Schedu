import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ItemStatus } from "@/types";

/** The round task checkbox: empty, half-filled (in progress) or filled (done). */
export function TaskCheck({
  status,
  overdue = false,
  label,
  onToggle,
  size = 20,
}: {
  status: ItemStatus;
  overdue?: boolean;
  label: string;
  onToggle: () => void;
  size?: number;
}) {
  const done = status === "Completed";
  const inProgress = status === "In Progress";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done ? "true" : inProgress ? "mixed" : "false"}
      aria-label={done ? `Mark “${label}” not done` : `Complete “${label}”`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      style={{ width: size, height: size }}
      className={cn(
        "group/check relative flex shrink-0 items-center justify-center rounded-full border-[1.6px] transition-colors",
        done
          ? "border-transparent bg-fg3 text-background"
          : inProgress
            ? "border-brand"
            : overdue
              ? "border-danger hover:bg-danger-soft"
              : "border-line2 hover:border-fg3",
      )}
    >
      {done && <Check className="size-3" strokeWidth={3.2} />}
      {inProgress && (
        <span className="absolute inset-[2.5px] rounded-full bg-[linear-gradient(90deg,var(--brand)_50%,transparent_50%)]" />
      )}
      {!done && !inProgress && (
        <Check className="size-3 text-fg3 opacity-0 transition-opacity group-hover/check:opacity-60" strokeWidth={3} />
      )}
    </button>
  );
}

export function Dot({ color, className, square = true }: { color: string; className?: string; square?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 shrink-0", square ? "rounded-[3px]" : "rounded-full", className)}
      style={{ background: color }}
    />
  );
}

/** Apple-style segmented control. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = "md",
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex gap-0.5 rounded-[10px] bg-sunken p-[3px]">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded-lg px-3.5 text-[13.5px] transition-colors",
              size === "sm" ? "h-7" : "h-[30px]",
              active ? "bg-card font-medium text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-fg2 hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** Soft card used for the right-hand widgets and stat tiles. */
export function Panel({
  title,
  action,
  children,
  className,
  elevated = false,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  elevated?: boolean;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-4 rounded-2xl border border-line bg-card p-5",
        elevated && "shadow-soft",
        className,
      )}
    >
      {(title || action) && (
        <div className="flex items-baseline justify-between gap-3">
          {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
          {action && <div className="text-[13px] text-fg3">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** The slim bar across the top of every page: breadcrumb left, actions right. */
export function TopBar({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-h-[52px] flex-wrap items-center justify-between gap-3 border-b border-line px-7 py-2 text-sm">
      <div className="flex min-w-0 items-center gap-1.5 text-fg2">{children}</div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="lo-kbd">{children}</kbd>;
}

export function PrimaryButton({
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex h-[34px] items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 [&_svg]:size-[15px]",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex h-[34px] items-center gap-1.5 rounded-lg border border-line2 px-3.5 text-[13.5px] font-medium transition-colors hover:bg-hover disabled:opacity-50 [&_svg]:size-[15px]",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="px-3 py-6 text-center text-sm text-fg3">{children}</p>;
}

export function StatTile({ label, value, hint, hintTone }: { label: string; value: ReactNode; hint?: ReactNode; hintTone?: "good" | "bad" }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-[14px] border border-line p-[18px]">
      <span className="text-[13px] text-fg3">{label}</span>
      <span className="text-[30px] font-semibold leading-tight tracking-tight tabular-nums">{value}</span>
      {hint && (
        <span className={cn("text-[12.5px]", hintTone === "good" ? "text-success" : hintTone === "bad" ? "text-danger" : "text-fg3")}>
          {hint}
        </span>
      )}
    </div>
  );
}
