import type { ComponentProps } from "react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

type IconButtonProps = Omit<ComponentProps<typeof Button>, "size" | "aria-label"> & {
  label: string
}

export function IconButton({ label, ...props }: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon" aria-label={label} {...props} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
