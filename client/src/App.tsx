import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SessionProvider, useSession } from "@/lib/session";
import NotFound from "@/pages/not-found";
import GuestPage from "@/pages/guest";
import LoginPage from "@/pages/login";
import InboxPage from "@/pages/inbox";
import TasksPage from "@/pages/tasks";
import ApprovalsPage from "@/pages/approvals";
import RoomsPage from "@/pages/rooms";
import ReservationsPage from "@/pages/reservations";
import InsightsPage from "@/pages/insights";
import CheckinPage from "@/pages/checkin";
import RegistrationsPage from "@/pages/registrations";
import RequestsPage from "@/pages/requests";
import KnowledgePage from "@/pages/knowledge";
import PoliciesPage from "@/pages/policies";
import CampaignsPage from "@/pages/campaigns";
import AuditPage from "@/pages/audit";
import BenchmarkPage from "@/pages/benchmark";
import TracesPage from "@/pages/traces";
import GuardrailsPage from "@/pages/guardrails";
import SettingsPage from "@/pages/settings";
import PayPage from "@/pages/pay";
import { StaffShell } from "@/components/staff-shell";
import type { Capability } from "@/lib/types";

/**
 * wouter's hash location returns the full hash including any query string
 * (`/?code=AUR-9K52JH`), which never matches a route. Strip it — deep-link
 * params are read from `window.location.hash` by the pages that need them.
 */
function useAppLocation(): [string, (to: string, options?: { replace?: boolean }) => void] {
  const [loc, navigate] = useHashLocation();
  const path = loc.split("?")[0] || "/";
  return [path, navigate];
}

/** Staff pages require a signed-in team member; guests never see them. */
/**
 * @param needs Capability the page's data requires. The server enforces it
 * (server/rbac.ts); this only decides whether to render the page or a plain
 * explanation, so a housekeeping attendant sees a sentence instead of a screen
 * of failed requests.
 */
function Protected({ component: Component, needs }: { component: () => JSX.Element; needs?: Capability }) {
  const { staff } = useSession();
  if (!staff) return <LoginPage />;
  const held = staff.capabilities;
  if (needs && held && !held.includes(needs)) return <NoAccess needs={needs} staff={staff} />;
  return <Component />;
}

function NoAccess({ needs, staff }: { needs: Capability; staff: { role: string; dept: string } }) {
  const DEPT: Record<string, string> = {
    front_desk: "Lễ tân", housekeeping: "Buồng phòng", fnb: "Ẩm thực",
    engineering: "Kỹ thuật", spa: "Spa",
  };
  return (
    <StaffShell title="Không có quyền" description="Mục này không thuộc phạm vi công việc của bạn">
      <div className="max-w-lg rounded-md border border-card-border bg-card p-4 text-sm">
        <p>
          Bạn đang đăng nhập với vai trò <span className="font-medium">{staff.role}</span> ·{" "}
          <span className="font-medium">{DEPT[staff.dept] ?? staff.dept}</span>.
        </p>
        <p className="mt-2 text-muted-foreground">
          Mục này cần quyền <code>{needs}</code>. Ở khách sạn, thông tin khách và các quyết định về
          tiền thuộc về Lễ tân; các bộ phận khác làm việc theo bảng công việc của mình.
        </p>
        <p className="mt-2 text-muted-foreground">
          Cần xem mục này thì nhờ quản lý cấp quyền hoặc đăng nhập bằng tài khoản Lễ tân.
        </p>
      </div>
    </StaffShell>
  );
}

/**
 * Where a person lands after signing in.
 *
 * `/staff` is the Inbox, which a department agent cannot open — so without this
 * a housekeeping sign-in arrived directly at a refusal. Their home is the task
 * board, which is their actual job.
 */
function StaffHome() {
  const { staff } = useSession();
  if (!staff) return <LoginPage />;
  const held = staff.capabilities;
  if (held && !held.includes("all_conversations")) return <TasksPage />;
  return <InboxPage />;
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={GuestPage} />
      {/* Guest-facing, token in the URL. Above the staff routes because it must
          never require a session. */}
      <Route path="/pay/:token" component={PayPage} />
      <Route path="/staff" component={() => <Protected component={StaffHome} />} />
      <Route path="/staff/tasks" component={() => <Protected component={TasksPage} />} />
      <Route path="/staff/approvals" component={() => <Protected component={ApprovalsPage} needs="approvals" />} />
      <Route path="/staff/rooms" component={() => <Protected component={RoomsPage} needs="rooms" />} />
      <Route
        path="/staff/reservations"
        component={() => <Protected component={ReservationsPage} needs="guest_data" />}
      />
      <Route path="/staff/requests" component={() => <Protected component={RequestsPage} />} />
      <Route path="/staff/checkin" component={() => <Protected component={CheckinPage} needs="guest_data" />} />
      <Route path="/staff/registrations" component={() => <Protected component={RegistrationsPage} needs="guest_data" />} />
      <Route path="/staff/insights" component={() => <Protected component={InsightsPage} needs="insights" />} />
      <Route path="/staff/knowledge" component={() => <Protected component={KnowledgePage} needs="edit_content" />} />
      <Route path="/staff/policies" component={() => <Protected component={PoliciesPage} needs="edit_content" />} />
      <Route path="/staff/campaigns" component={() => <Protected component={CampaignsPage} needs="configure" />} />
      <Route path="/staff/benchmark" component={() => <Protected component={BenchmarkPage} needs="configure" />} />
      <Route path="/staff/traces" component={() => <Protected component={TracesPage} needs="configure" />} />
      <Route path="/staff/audit" component={() => <Protected component={AuditPage} needs="configure" />} />
      <Route path="/staff/guardrails" component={() => <Protected component={GuardrailsPage} needs="configure" />} />
      <Route path="/staff/settings" component={() => <Protected component={SettingsPage} needs="configure" />} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <TooltipProvider>
          <Toaster />
          <Router hook={useAppLocation}>
            <AppRouter />
          </Router>
        </TooltipProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}

export default App;
