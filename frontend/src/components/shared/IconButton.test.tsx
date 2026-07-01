// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import { Plus } from "lucide-react"
import { describe, expect, it } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import { IconButton } from "@/components/shared/IconButton"

describe("IconButton", () => {
  it("exposes a concise accessible action name", () => {
    render(
      <TooltipProvider>
        <IconButton label="Add file">
          <Plus />
        </IconButton>
      </TooltipProvider>,
    )

    expect(screen.getByRole("button", { name: "Add file" })).toBeTruthy()
  })
})
