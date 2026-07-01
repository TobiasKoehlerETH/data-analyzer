import { Moon, Sun } from "lucide-react"
import { useTheme } from "@/components/theme-provider"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"

export function ModeToggle() {
  const { theme, toggle } = useTheme()
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={toggle} tooltip="Toggle theme">
          {theme === "light" ? <Moon /> : <Sun />}
          <span>{theme === "light" ? "Dark mode" : "Light mode"}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
