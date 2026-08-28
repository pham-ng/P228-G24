import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  BedDouble,
  BookOpen,
  ClipboardList,
  Inbox,
  LogOut,
  Megaphone,
  Menu,
  Moon,
  FlaskConical,
  Radar,
  ScrollText,
  Scale,
  Settings,
  ShieldCheck,
  ShieldAlert,
  Sun,
  CalendarRange,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { AureaLogo } from "./logo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useSession } from "@/lib/session";
import type { ConversationRow, ServiceApproval, Task } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * `needs` is the capability the page's data requires. Hiding a link is a
 * courtesy, not a control — the server refuses the request either way
 * (server/rbac.ts). It is here so a housekeeping attendant is not handed a menu
 * of six things that answer 403, which reads as a broken product rather than as
 * a permission boundary.
 *
 * Tasks and Rooms carry no `needs`: everybody works from those, and the task
 * list is FILTERED to the person's department rather than refused.
 */
const NAV = [
  { href: "/staff", label: "Inbox", icon: Inbox, badge: "inbox" as const, needs: "all_conversations" as const },
  { href: "/staff/approvals", label: "Approvals", icon: ShieldCheck, badge: "approvals" as const, needs: "approvals" as const },
  { href: "/staff/tasks", label: "Tasks", icon: ClipboardList, badge: "tasks" as const },
  { href: "/staff/rooms", label: "Rooms", icon: BedDouble, needs: "rooms" as const },
  { href: "/staff/reservations", label: "Reservations", icon: CalendarRange, needs: "guest_data" as const },
  { href: "/staff/insights", label: "Insights", icon: BarChart3, needs: "insights" as const },
  { href: "/staff/knowledge", label: "Knowledge", icon: BookOpen, needs: "edit_content" as const },
  { href: "/staff/policies", label: "Policies", icon: Scale, needs: "edit_content" as const },
  { href: "/staff/campaigns", label: "Campaigns", icon: Megaphone, needs: "configure" as const },
  { href: "/staff/benchmark", label: "Benchmark", icon: FlaskConical, needs: "configure" as const },
  { href: "/staff/guardrails", label: "Guardrails", icon: ShieldAlert, needs: "configure" as const },
  { href: "/staff/traces", label: "Traces", icon: Radar, needs: "configure" as const },
  { href: "/staff/audit", label: "Activity", icon: ScrollText, needs: "configure" as const },
  { href: "/staff/settings", label: "Settings", icon: Settings, needs: "configure" as const },
];

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();
  const { staff } = useSession();
  const held = staff?.capabilities;
  /* No capability list means an older session or none at all; showing
     everything then keeps the shell working while the server still refuses. */
  const allowed = (need?: string) => !need || !held || held.includes(need as never);

  const { data: convs } = useQuery<ConversationRow[]>({
    queryKey: ["/api/conversations"],
    refetchInterval: 8000,
    enabled: allowed("all_conversations"),
  });
  const { data: tasks } = useQuery<Task[]>({ queryKey: ["/api/tasks"], refetchInterval: 8000 });
  const { data: approvals } = useQuery<ServiceApproval[]>({
    queryKey: ["/api/approvals"],
    refetchInterval: 8000,
    /* Without this the badge query 403s every eight seconds for every
       department agent, filling the console with errors that look like a bug. */
    enabled: allowed("approvals"),
  });

  const counts = {
    inbox: convs?.filter((c) => c.unreadForStaff === 1).length ?? 0,
    tasks: tasks?.filter((t) => t.status === "open" || t.status === "in_progress").length ?? 0,
    approvals: approvals?.filter((a) => a.status === "pending").length ?? 0,
  };

  return (
    <nav className="flex flex-col gap-0.5 px-2">
      {NAV.filter((item) => allowed(item.needs)).map((item) => {
        const active =
          item.href === "/staff" ? location === "/staff" : location.startsWith(item.href);
        const count = item.badge ? counts[item.badge] : 0;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            data-testid={`nav-${item.label.toLowerCase()}`}
            className={cn(
              "hover-elevate flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
              active
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-muted-foreground",
            )}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate">{item.label}</span>
            {count > 0 && (
              <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">
                {count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

const DEPT_LABEL: Record<string, string> = {
  front_desk: "Lễ tân",
  housekeeping: "Buồng phòng",
  fnb: "Ẩm thực",
  engineering: "Kỹ thuật",
  spa: "Spa",
};

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const { staff, signOut, theme, toggleTheme } = useSession();
  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="px-4 py-4">
        <AureaLogo subtitle="Operations" />
      </div>
      <div className="flex-1 overflow-y-auto pb-4">
        <NavList onNavigate={onNavigate} />
      </div>
      <div className="border-t border-sidebar-border p-3">
        {staff && (
          <div className="mb-2 flex items-center gap-2.5 px-1">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono text-[11px] font-semibold text-primary">
              {staff.avatarInitials}
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-medium">{staff.name}</div>
              {/* Department, not just role: on this board the department is what
                  decides what you can see, so it is the thing to show. */}
              <div className="truncate text-xs text-muted-foreground">
                {staff.role} · {DEPT_LABEL[staff.dept] ?? staff.dept}
              </div>
            </div>
          </div>
        )}
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={toggleTheme}
            data-testid="button-theme"
          >
            {theme === "light" ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
            <span className="ml-1.5 text-xs">{theme === "light" ? "Dark" : "Light"}</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={signOut}
            data-testid="button-signout"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="ml-1.5 text-xs">Sign out</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

export function StaffShell({
  title,
  description,
  actions,
  children,
  padded = true,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  padded?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <aside className="hidden w-60 shrink-0 border-r border-sidebar-border md:block">
        <SidebarBody />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" data-testid="button-menu">
                <Menu className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0">
              <SidebarBody onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold tracking-tight">{title}</h1>
            {description && (
              <p className="truncate text-xs text-muted-foreground">{description}</p>
            )}
          </div>
          {actions}
        </header>
        <main className={cn("min-h-0 flex-1 overflow-y-auto", padded && "p-4 md:p-6")}>
          {children}
        </main>
      </div>
    </div>
  );
}
