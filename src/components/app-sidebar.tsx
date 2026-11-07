import * as React from "react"

import { NavDocuments } from "@/components/nav-documents"
import { NavMain } from "@/components/nav-main"
import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { LayoutDashboardIcon, ListIcon, TagsIcon, DatabaseIcon, FileChartColumnIcon, CommandIcon } from "lucide-react"

const data = {
  user: {
    name: "LiteLLM Admin",
    email: "Usage Console",
    avatar: "",
  },
  navMain: [
    {
      title: "用量概览",
      url: "/",
      icon: (
        <LayoutDashboardIcon
        />
      ),
    },
    {
      title: "模型健康",
      url: "/health",
      icon: (
        <ListIcon
        />
      ),
    },
    {
      title: "模型管理",
      url: "#",
      icon: (
        <TagsIcon
        />
      ),
    },
  ],
  documents: [
    {
      name: "用量报告",
      url: "#",
      icon: (
        <DatabaseIcon
        />
      ),
    },
    {
      name: "支出预算",
      url: "#",
      icon: (
        <FileChartColumnIcon
        />
      ),
    },
  ],
}

export function AppSidebar({
  activePage,
  onPageChange,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  activePage: string
  onPageChange: (page: string) => void
}) {
  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:p-1.5!"
            >
              <a href="/">
                <CommandIcon className="size-5!" />
                <span className="text-base font-semibold">LiteLLM</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} activePage={activePage} onPageChange={onPageChange} />
        <NavDocuments items={data.documents} activePage={activePage} onPageChange={onPageChange} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={data.user} />
      </SidebarFooter>
    </Sidebar>
  )
}
