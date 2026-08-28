/**
 * A spa therapist must not be able to read a guest's passport number.
 *
 * Every staff member presented the same `STAFF_API_TOKEN`, so the API could
 * authenticate a request and still not know whose it was: 150 of 201 audit
 * events recorded `staff:0`, and anyone who could sign in could open any
 * guest's folio, identity documents and chat history.
 *
 * The model here is hotel work, not a permission tree: the front desk owns the
 * guest relationship, so it sees the guest; everyone else owns a job, so they
 * see the job. These assertions pin that shape — including the two things it is
 * easy to get wrong in the other direction, which are that a department agent
 * must still see their OWN task board, and must still be able to read the
 * conversation behind a task they were sent to do.
 */
import "dotenv/config";
import { can, capabilitiesOf, visibleDepartments, canReadConversation, actorLabel, type Actor } from "../server/rbac";

let failures = 0;
function ok(cond: boolean, label: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

const manager: Actor = { id: 1, name: "Nguyễn Thị Lan", role: "manager", dept: "front_desk" };
const desk: Actor = { id: 2, name: "Trần Quốc Bảo", role: "agent", dept: "front_desk" };
const housekeeping: Actor = { id: 3, name: "Phạm Thị Hoa", role: "agent", dept: "housekeeping" };
const fnb: Actor = { id: 4, name: "Lê Văn Thành", role: "agent", dept: "fnb" };
const engineering: Actor = { id: 5, name: "Đỗ Minh Khoa", role: "agent", dept: "engineering" };
const spa: Actor = { id: 6, name: "Võ Thanh Trúc", role: "agent", dept: "spa" };
const service: Actor = { id: 0, name: "service", role: "manager", dept: "front_desk", service: true };

console.log("=== quản lý thấy tất cả ===");
for (const cap of ["guest_data", "all_conversations", "all_tasks", "approvals", "insights", "rooms", "edit_content", "configure"] as const) {
  ok(can(manager, cap), `manager: ${cap}`);
}

console.log("\n=== lễ tân: khách và tiền, nhưng KHÔNG cấu hình ===");
for (const cap of ["guest_data", "all_conversations", "converse", "all_tasks", "approvals", "rooms"] as const) {
  ok(can(desk, cap), `desk agent CÓ ${cap}`);
}
/* An agent runs the shift; a manager runs the hotel. Business figures and the
   guardrail switches are not a shift-level decision. */
for (const cap of ["insights", "configure", "edit_content"] as const) {
  ok(!can(desk, cap), `desk agent KHÔNG có ${cap}`);
}

console.log("\n=== các bộ phận khác: KHÔNG chạm dữ liệu khách ===");
for (const actor of [housekeeping, fnb, engineering, spa]) {
  for (const cap of ["guest_data", "all_conversations", "approvals", "insights", "configure", "all_tasks"] as const) {
    ok(!can(actor, cap), `${actor.dept.padEnd(13)} KHÔNG có ${cap}`);
  }
}

console.log("\n=== nhưng buồng phòng và kỹ thuật vẫn cần trạng thái phòng ===");
/* Their work is physically in the rooms; refusing the room board would stop
   them doing the job the task assigns. */
ok(can(housekeeping, "rooms"), "buồng phòng CÓ rooms");
ok(can(engineering, "rooms"), "kỹ thuật CÓ rooms");
ok(!can(fnb, "rooms"), "ẩm thực KHÔNG cần rooms");
ok(!can(spa, "rooms"), "spa KHÔNG cần rooms");

console.log("\n=== bảng việc: LỌC chứ không từ chối ===");
/* The task board is the department agent's whole job. Refusing it would be
   worse than the leak the rest of this file prevents. */
ok(visibleDepartments(manager) === null, "manager thấy mọi bộ phận");
ok(visibleDepartments(desk) === null, "lễ tân thấy mọi bộ phận");
ok(JSON.stringify(visibleDepartments(housekeeping)) === '["housekeeping"]', "buồng phòng chỉ thấy việc của mình");
ok(JSON.stringify(visibleDepartments(spa)) === '["spa"]', "spa chỉ thấy việc của mình");

console.log("\n=== hội thoại: vào được QUA công việc của mình ===");
/* An engineer sent to fix an air conditioner has to be able to read what the
   guest said was wrong with it. */
const tasksOn = (id: number) =>
  ({
    7: [{ dept: "engineering" }],
    8: [{ dept: "housekeeping" }],
    9: [] as { dept: string }[],
  })[id] ?? [];

ok(canReadConversation(engineering, 7, tasksOn), "kỹ thuật đọc được hội thoại có task của mình");
ok(!canReadConversation(engineering, 8, tasksOn), "kỹ thuật KHÔNG đọc được hội thoại của buồng phòng");
ok(!canReadConversation(spa, 9, tasksOn), "spa KHÔNG đọc được hội thoại không có task nào");
ok(canReadConversation(desk, 9, tasksOn), "lễ tân đọc được mọi hội thoại");

console.log("\n=== token dịch vụ (bench, script) vẫn chạy được ===");
/* Benches and the demo builder present the legacy shared token. Tightening the
   boundary must not break the tooling that is not part of it. */
ok(can(service, "guest_data") && can(service, "configure"), "service có toàn quyền");
ok(actorLabel(service) === "service", "audit phân biệt được service");
ok(actorLabel(housekeeping) === "staff:3", "audit ghi đúng id nhân viên");
ok(actorLabel(null) === "system", "không có actor thì ghi system");

console.log("\n=== không rò quyền qua tham chiếu chung ===");
/* capabilitiesOf returns a fresh array; a caller mutating it must not widen
   what the next caller is granted. */
const a = capabilitiesOf(housekeeping);
a.push("guest_data");
ok(!can(housekeeping, "guest_data"), "sửa mảng trả về không ảnh hưởng quyền thật");

console.log(failures === 0 ? "\nALL RBAC TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
