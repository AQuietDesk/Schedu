import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// Apple-style toggle: green when on, white thumb in both themes.
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-[26px] w-[44px] shrink-0 items-center rounded-full p-[2px] transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:bg-success data-unchecked:bg-line2 data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-[22px] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25)] transition-transform data-checked:translate-x-[18px] data-unchecked:translate-x-0"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
