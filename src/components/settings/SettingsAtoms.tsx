// Layout pieces shared by the Settings sections.
import type { ReactNode } from "react";

export function Group({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      {title && <h2 className="ml-1 text-[13px] font-medium text-fg3">{title}</h2>}
      <div className="flex flex-col rounded-[14px] border border-line bg-sidebar [&>*+*]:border-t [&>*+*]:border-line">{children}</div>
      {footer && <p className="ml-1 text-[12.5px] leading-snug text-fg3">{footer}</p>}
    </section>
  );
}

export function SettingRow({ label, description, children, htmlFor }: { label: ReactNode; description?: ReactNode; children?: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex min-h-[52px] flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5">
      <label htmlFor={htmlFor} className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[14.5px]">{label}</span>
        {description && <span className="text-[12.5px] text-fg3">{description}</span>}
      </label>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}
