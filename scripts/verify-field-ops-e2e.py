#!/usr/bin/env python3
"""
End-to-end verification of the field-operations flow against a running server.

This is deliberately NOT a mocked unit test. It seeds a real database and drives
the real HTTP API, because the requirements that matter most — consolidation
without losing traceability, "only received quantities become deliverable", and
"a partial delivery never rewrites history" — are enforced across several
handlers and a mocked test cannot prove they hold together.

The scenario is the one in the brief: the SAME contactor appears on three
supplier POs (SPO-001/005/009), each allocated to a different customer PO
(P26E001/014/021) with 2/3/1 units. The rep must see ONE consolidated line
totalling 6, but receiving 4 must leave only the right quantities deliverable.

Usage:
    python3 scripts/verify-field-ops-e2e.py [base_url] [db_container]
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import urllib.error
import urllib.request
from urllib.parse import quote

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18080"
DB = sys.argv[2] if len(sys.argv) > 2 else "cortoba-pg"

# In a container-in-a-container dev shell docker needs sudo; in CI it does not.
DOCKER = shlex.split(os.environ.get("DOCKER", "sudo docker"))

# How to reach Postgres for seeding and assertions. Default: psql inside the DB
# container. CI sets PSQL_CMD to talk to a service container over TCP instead,
# because there is no named container to `docker exec` into there.
PSQL_CMD = os.environ.get("PSQL_CMD")
if PSQL_CMD:
    PSQL = shlex.split(PSQL_CMD)
else:
    PSQL = [*DOCKER, "exec", DB, "psql", "-U", "cortoba", "-d", "rfq"]

# bcrypt("FieldOps!2026"), generated once so the script needs no hashing library.
PW_HASH = "$2b$10$MPboRpnxOO6BIRNQPQlnL.8JD9LrgKybQ1oa3/W9BQjP4Y8ryeVU6"
PASSWORD = "FieldOps!2026"

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    (PASS if ok else FAIL).append(name)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")


def sql(statement: str) -> str:
    r = subprocess.run(
        [*PSQL, "-tA", "-c", statement],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    # psql prints a command tag ("INSERT 0 1") after RETURNING rows; drop it so
    # callers that read a single value get just that value.
    lines = [ln for ln in r.stdout.splitlines()
             if not ln.startswith(("INSERT ", "UPDATE ", "DELETE ", "SELECT "))]
    return "\n".join(lines).strip()


def api(method: str, path: str, token: str | None = None, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as resp:
            raw, status = resp.read().decode(), resp.status
    except urllib.error.HTTPError as e:
        raw, status = e.read().decode(), e.code
    try:
        return status, json.loads(raw)
    except json.JSONDecodeError:
        return status, raw


def seed() -> tuple[int, int]:
    print("\n[seed] resetting field-operations data")
    sql(
        """
        DELETE FROM mobile_attachments;
        DELETE FROM po_item_receipts;
        DELETE FROM customer_po_item_deliveries;
        DELETE FROM work_order_delegations;
        DELETE FROM mobile_notifications;
        DELETE FROM mobile_sessions;
        DELETE FROM work_order_assignments;
        DELETE FROM purchase_order_items;
        DELETE FROM customer_po_items;
        DELETE FROM purchase_orders;
        DELETE FROM customer_pos;
        DELETE FROM hr_field_assignments;
        DELETE FROM hr_employees WHERE employee_no IN ('E2E-100', 'E2E-200');
        DELETE FROM suppliers WHERE name LIKE 'E2E Supplier%';
        """
    )
    emp = sql(
        f"""
        INSERT INTO hr_employees (employee_no, full_name, job_title, department, status,
                                  mobile_access_enabled, mobile_password_hash, phone)
        VALUES ('E2E-100', 'مندوب اختبار', 'مندوب ميداني', 'المشتريات', 'active', true,
                '{PW_HASH}', '201000000001')
        RETURNING id;
        """
    )
    sql(f"INSERT INTO hr_field_assignments (employee_id, status) VALUES ({emp}, 'active');")
    supplier = sql(
        "INSERT INTO suppliers (name, phone, address, contact_person) "
        "VALUES ('E2E Supplier Alpha', '201111111111', 'القاهرة', 'حسن') RETURNING id;"
    )

    # (supplier PO no, customer PO no, quantity) — the brief's exact example.
    scenario = [("SPO-001", "P26E001", 2), ("SPO-005", "P26E014", 3),
                ("SPO-009", "P26E021", 1)]
    for idx, (spo_no, cpo_no, qty) in enumerate(scenario, start=1):
        cpo = sql(
            f"INSERT INTO customer_pos (internal_po_no, customer_po_no, customer_name, status) "
            f"VALUES ('CPO-E2E-{idx}', '{cpo_no}', 'عميل {idx}', 'confirmed') RETURNING id;"
        )
        cpi = sql(
            f"INSERT INTO customer_po_items (customer_po_id, description, qty, uom) "
            f"VALUES ({cpo}, 'كونتاكتور شنايدر LC1D32M7', {qty}, 'قطعة') RETURNING id;"
        )
        # The supplier lives on the PO's lines, not on the PO header.
        po = sql(
            f"INSERT INTO purchase_orders (internal_po_no, sheet_po_no, status) "
            f"VALUES ('{spo_no}', '{spo_no}', 'draft') RETURNING id;"
        )
        # customer_po_item_id is what makes the receipt chain a delivery task.
        po_item = sql(
            f"INSERT INTO purchase_order_items "
            f"(po_id, line_item, description, qty, uom, supplier_id, line_status, "
            f" customer_po_item_id) "
            f"VALUES ({po}, '{idx}', 'كونتاكتور شنايدر LC1D32M7', {qty}, 'قطعة', "
            f"{supplier}, 'pending', {cpi}) RETURNING id;"
        )
        sql(
            f"INSERT INTO work_order_assignments "
            f"(po_id, po_item_id, customer_po_id, customer_po_item_id, kind, status, "
            f" hr_employee_id, representative_name, representative_phone) "
            f"VALUES ({po}, {po_item}, {cpo}, {cpi}, 'receipt', 'sent', "
            f"{emp}, 'مندوب اختبار', '201000000001');"
        )
    print(f"[seed] representative id={emp}, supplier id={supplier}")
    return int(emp), int(supplier)


def main() -> int:
    print(f"Verifying {BASE}")
    emp, supplier = seed()

    print("\n[1] login with employee number + password")
    status, body = api("POST", "/api/mobile/auth/login",
                       body={"employeeNo": "E2E-100", "password": PASSWORD})
    check("login succeeds", status == 200, f"status={status} body={body}")
    if status != 200:
        return report()
    token = body["token"]
    check("login returns a bearer token", bool(token))
    check("login marks the employee a field representative",
          body.get("isFieldRepresentative") is True)

    print("\n[2] wrong password is rejected")
    status, _ = api("POST", "/api/mobile/auth/login",
                    body={"employeeNo": "E2E-100", "password": "wrong"})
    check("wrong password rejected (401)", status == 401, f"status={status}")

    print("\n[3] inactive employee cannot log in")
    sql("UPDATE hr_employees SET status = 'resigned' WHERE employee_no = 'E2E-100';")
    status, _ = api("POST", "/api/mobile/auth/login",
                    body={"employeeNo": "E2E-100", "password": PASSWORD})
    check("inactive employee rejected (403)", status == 403, f"status={status}")
    sql("UPDATE hr_employees SET status = 'active' WHERE employee_no = 'E2E-100';")

    print("\n[4] consolidation — 3 POs of the same item become ONE line totalling 6")
    status, pickups = api("GET", "/api/mobile/pickups", token)
    check("pickups list loads", status == 200, f"status={status}")
    items = pickups.get("consolidatedItems", [])
    check("exactly one consolidated item", len(items) == 1, f"got {len(items)}")
    line = items[0] if items else None
    if line:
        check("total required quantity is 6",
              abs(float(line["totalRequiredQty"]) - 6) < 1e-6,
              f"got {line.get('totalRequiredQty')}")
        allocs = line.get("allocations", [])
        check("all three POs are retained as allocations", len(allocs) == 3,
              f"got {len(allocs)}")
        pairs = sorted((a["poNo"], (a.get("customerPoNos") or [None])[0], float(a["qty"]))
                       for a in allocs)
        check("allocation is SPO-001/P26E001/2, SPO-005/P26E014/3, SPO-009/P26E021/1",
              pairs == [("SPO-001", "P26E001", 2.0),
                        ("SPO-005", "P26E014", 3.0),
                        ("SPO-009", "P26E021", 1.0)],
              f"got {pairs}")
        check("supplier PO cards are one per PO", len(pickups.get("tasks", [])) == 3,
              f"got {len(pickups.get('tasks', []))}")

    print("\n[5] delivery is blocked until receiving is confirmed")
    status, deliveries = api("GET", "/api/mobile/deliveries", token)
    check("deliveries list loads", status == 200, f"status={status}")
    check("nothing is deliverable before receiving",
          len(deliveries.get("tasks", [])) == 0,
          f"got {len(deliveries.get('tasks', []))}")

    if not line:
        return report()

    print("\n[6] partial receiving — 4 of 6 across two POs")
    # The allocation line carries poItemId; the per-PO task card carries the
    # assignmentId used to confirm. Receive 2 of 2 on SPO-001 and 2 of 3 on
    # SPO-005; leave SPO-009 (1 unit) unreceived.
    by_po = {a["poNo"]: a for a in line["allocations"]}
    task_by_po = {t["poNo"]: t for t in pickups.get("tasks", [])}
    for po_no, want in (("SPO-001", 2), ("SPO-005", 2)):
        alloc = by_po[po_no]
        task = task_by_po[po_no]
        status, body = api("POST", f"/api/mobile/pickups/{task['assignmentId']}/confirm",
                           token, {"items": [{"poItemId": alloc["poItemId"],
                                              "receivedQty": want}],
                                   "clientUuid": f"e2e-receipt-{po_no}"})
        check(f"receiving {want} on {po_no} accepted", status == 200,
              f"status={status} body={body}")

    print("\n[7] only received quantities become deliverable")
    status, deliveries = api("GET", "/api/mobile/deliveries", token)
    tasks = deliveries.get("tasks", [])
    deliverable = sum(float(t.get("availableQty", 0)) for t in tasks)
    check("exactly 4 units are deliverable", abs(deliverable - 4) < 1e-6,
          f"got {deliverable} across {len(tasks)} task(s)")
    # Each task is now ONE CUSTOMER carrying their purchase orders. The customer
    # behind P26E021 must not appear at all — its only line was never received.
    check("the unreceived SPO-009 customer line is NOT deliverable",
          all(t["customerName"] != "عميل 3" for t in tasks),
          f"customers offered: {[t['customerName'] for t in tasks]}")
    check("each card is one customer with their PO count",
          all(t.get("poCount", 0) >= 1 for t in tasks),
          f"poCounts: {[t.get('poCount') for t in tasks]}")

    print("\n[8] a partial delivery leaves the remainder, and history is preserved")
    # The customer carrying P26E014 (عميل 2) is the target. Open the customer
    # screen, then its PO detail — the rep drills customer → PO.
    target = next((t for t in tasks if t["customerName"] == "عميل 2"), None)
    check("the عميل 2 customer card exists", target is not None)
    cpi_id = None
    assignment_id = None
    if target:
        # The seed creates name-only customers (no customer id), so the card's
        # key is `name:<name>` and the detail is fetched by name.
        key = target["key"]
        kind, _, value = key.partition(":")
        query = f"id={value}" if kind == "id" else f"name={quote(value)}"
        detail_status, cdetail = api(
            "GET", f"/api/mobile/deliveries/customer?{query}", token)
        check("customer detail loads", detail_status == 200, f"status={detail_status}")
        pos = cdetail.get("purchaseOrders", [])
        po = next((p for p in pos if p["customerPoNo"] == "P26E014"), None)
        check("the customer carries the P26E014 purchase order", po is not None,
              f"POs={[p['customerPoNo'] for p in pos]}")
        if po:
            assignment_id = po["assignmentId"]
            check("the purchase order carries a delivery assignment",
                  assignment_id is not None)
            d_items = po.get("items", [])
            check("the line reports 2 available of 3 ordered",
                  bool(d_items) and abs(float(d_items[0]["availableQty"]) - 2) < 1e-6,
                  f"items={d_items}")
            if d_items and assignment_id is not None:
                cpi_id = d_items[0]["customerPoItemId"]
                status, body = api("POST", f"/api/mobile/deliveries/{assignment_id}/confirm",
                                   token, {"items": [{"customerPoItemId": cpi_id, "deliveredQty": 1}],
                                           "recipientName": "مستلم اختبار",
                                           "operationKey": "e2e-delivery-1"})
                check("partial delivery accepted", status == 200, f"status={status} body={body}")

                status, d2 = api("GET", "/api/mobile/deliveries", token)
                remaining = sum(float(x.get("availableQty", 0)) for x in d2.get("tasks", []))
                check("remaining deliverable quantity is 3", abs(remaining - 3) < 1e-6,
                      f"got {remaining}")
                rows = sql("SELECT count(*) FROM customer_po_item_deliveries "
                           "WHERE delivered_qty > 0;")
                check("the first delivery row still exists (history not overwritten)",
                      int(rows) >= 1, f"rows={rows}")

    print("\n[9] a duplicate confirmation is idempotent, not double-counted")
    if target and cpi_id and assignment_id is not None:
        api("POST", f"/api/mobile/deliveries/{assignment_id}/confirm",
            token, {"items": [{"customerPoItemId": cpi_id, "deliveredQty": 1}],
                    "operationKey": "e2e-delivery-1"})
        _, d3 = api("GET", "/api/mobile/deliveries", token)
        remaining = sum(float(x.get("availableQty", 0)) for x in d3.get("tasks", []))
        check("replaying the same operationKey does not deliver again",
              abs(remaining - 3) < 1e-6, f"remaining={remaining}")

    print("\n[9b] a fully delivered customer disappears from the list immediately")
    # The reported defect: work that was already delivered stayed on the list.
    # Deliver the last remaining unit of the عميل 2 PO; that customer must then
    # vanish from the list and from the customer detail.
    if assignment_id is not None and cpi_id is not None:
        status, body = api(
            "POST", f"/api/mobile/deliveries/{assignment_id}/confirm", token,
            {"items": [{"customerPoItemId": cpi_id, "deliveredQty": 1}],
             "recipientName": "مستلم اختبار",
             "operationKey": "e2e-delivery-final"})
        check("the final delivery is accepted", status == 200, f"status={status} body={body}")

        status, d4 = api("GET", "/api/mobile/deliveries", token)
        names = [t["customerName"] for t in d4.get("tasks", [])]
        check("the fully delivered customer is gone from the list",
              "عميل 2" not in names, f"customers={names}")
        remaining = sum(float(x.get("availableQty", 0)) for x in d4.get("tasks", []))
        check("only the other customer's 2 units remain deliverable",
              abs(remaining - 2) < 1e-6, f"got {remaining}")

        key = target["key"]
        kind, _, value = key.partition(":")
        query = f"id={value}" if kind == "id" else f"name={quote(value)}"
        status, cdetail2 = api("GET", f"/api/mobile/deliveries/customer?{query}", token)
        check("the customer detail hides the finished purchase order",
              status == 200 and len(cdetail2.get("purchaseOrders", [])) == 0,
              f"status={status} POs={cdetail2.get('purchaseOrders')}")

    print("\n[10] employee isolation — a second rep sees none of the first rep's work")
    other = sql(
        f"""
        INSERT INTO hr_employees (employee_no, full_name, status, mobile_access_enabled,
                                  mobile_password_hash)
        VALUES ('E2E-200', 'مندوب آخر', 'active', true, '{PW_HASH}') RETURNING id;
        """
    )
    sql(f"INSERT INTO hr_field_assignments (employee_id, status) VALUES ({other}, 'active');")
    status, body2 = api("POST", "/api/mobile/auth/login",
                        body={"employeeNo": "E2E-200", "password": PASSWORD})
    check("second representative can log in", status == 200, f"status={status}")
    if status == 200:
        status, p2 = api("GET", "/api/mobile/pickups", body2["token"])
        check("other representative sees no pickups",
              len(p2.get("consolidatedItems", [])) == 0,
              f"got {len(p2.get('consolidatedItems', []))}")
        status, d_other = api("GET", "/api/mobile/deliveries", body2["token"])
        check("other representative sees no deliveries",
              len(d_other.get("tasks", [])) == 0,
              f"got {len(d_other.get('tasks', []))}")

    print("\n[11] representative cannot reach the HR control plane")
    status, _ = api("GET", "/api/hr/field-ops/overview", token)
    check("mobile token is refused by the control API (401/403)",
          status in (401, 403), f"status={status}")

    print("\n[12] audit trail exists for the operations")
    audits = sql("SELECT count(*) FROM audit_log WHERE action LIKE 'mobile.%';")
    check("mobile audit rows were written", int(audits) > 0, f"rows={audits}")

    print("\n[12b] a supplier PO with several lines shows all of them in its detail")
    # The brief's consolidation example uses three POs of the SAME item. This
    # check covers the other real shape: ONE supplier PO carrying several
    # different items. Opening that PO's detail must list every line, not just
    # the single line behind whichever assignment id the card happened to carry.
    multi_po = sql(
        "INSERT INTO purchase_orders (internal_po_no, sheet_po_no, status) "
        "VALUES ('SPO-MULTI', 'SPO-MULTI', 'draft') RETURNING id;"
    )
    for idx2, label in enumerate(("كابل 3×2.5 نحاس", "قاطع 63 أمبير"), start=1):
        multi_item = sql(
            f"INSERT INTO purchase_order_items "
            f"(po_id, line_item, description, qty, uom, supplier_id, line_status) "
            f"VALUES ({multi_po}, '{idx2}', '{label}', 5, 'قطعة', "
            f"{supplier}, 'pending') RETURNING id;"
        )
        sql(
            f"INSERT INTO work_order_assignments "
            f"(po_id, po_item_id, kind, status, hr_employee_id, "
            f" representative_name, representative_phone) "
            f"VALUES ({multi_po}, {multi_item}, 'receipt', 'sent', "
            f"{emp}, 'مندوب اختبار', '201000000001');"
        )
    status, p3 = api("GET", "/api/mobile/pickups", token)
    multi_task = next((t for t in p3.get("tasks", []) if t["poNo"] == "SPO-MULTI"), None)
    check("the multi-line PO appears as one supplier card", multi_task is not None,
          f"tasks={[t['poNo'] for t in p3.get('tasks', [])]}")
    if multi_task:
        status, multi_detail = api(
            "GET", f"/api/mobile/pickups/{multi_task['assignmentId']}", token
        )
        check("detail loads for the multi-line PO", status == 200, f"status={status}")
        check("the detail lists BOTH lines (not just one)",
              len(multi_detail.get("items", [])) == 2,
              f"items={multi_detail.get('items')}")

    print("\n[12c] rejecting one line does not block the rest of the submission")
    # The reported defect: a rep who rejects ONE line (quantity 0) had the WHOLE
    # submission refused with «أدخل الكمية المستلمة أو المرفوضة», so the lines
    # they did receive could never be recorded. Rejecting one line must record it
    # as rejected and let the accepted lines through.
    rej_po = sql(
        "INSERT INTO purchase_orders (internal_po_no, sheet_po_no, status) "
        "VALUES ('SPO-REJECT', 'SPO-REJECT', 'draft') RETURNING id;"
    )
    cpo_rej = sql(
        "INSERT INTO customer_pos (internal_po_no, customer_po_no, customer_name, status) "
        "VALUES ('CPO-REJ', 'P26E-REJ', 'عميل الرفض', 'confirmed') RETURNING id;"
    )
    rej_items = []
    for idx3, label in enumerate(("بند مقبول", "بند مرفوض"), start=1):
        cpi = sql(
            f"INSERT INTO customer_po_items (customer_po_id, description, qty, uom) "
            f"VALUES ({cpo_rej}, '{label}', 5, 'قطعة') RETURNING id;"
        )
        item_id = sql(
            f"INSERT INTO purchase_order_items "
            f"(po_id, line_item, description, qty, uom, supplier_id, line_status, "
            f" customer_po_item_id) "
            f"VALUES ({rej_po}, '{idx3}', '{label}', 5, 'قطعة', {supplier}, 'pending', "
            f"{cpi}) RETURNING id;"
        )
        sql(
            f"INSERT INTO work_order_assignments "
            f"(po_id, po_item_id, customer_po_id, customer_po_item_id, kind, status, "
            f" hr_employee_id, representative_name, representative_phone) "
            f"VALUES ({rej_po}, {item_id}, {cpo_rej}, {cpi}, 'receipt', 'sent', "
            f"{emp}, 'مندوب اختبار', '201000000001');"
        )
        rej_items.append(int(item_id))
    status, p4 = api("GET", "/api/mobile/pickups", token)
    rej_task = next((t for t in p4.get("tasks", []) if t["poNo"] == "SPO-REJECT"), None)
    check("the rejection PO appears as a supplier card", rej_task is not None,
          f"tasks={[t['poNo'] for t in p4.get('tasks', [])]}")
    if rej_task:
        # Accept line 1 in full, reject line 2 with quantity 0.
        status, body = api(
            "POST", f"/api/mobile/pickups/{rej_task['assignmentId']}/confirm", token,
            {"items": [{"poItemId": rej_items[0], "receivedQty": 5},
                       {"poItemId": rej_items[1], "receivedQty": 0, "rejectedQty": 0}],
             "clientUuid": "e2e-receipt-reject"})
        check("a submission mixing an accepted and a rejected line is accepted",
              status == 200, f"status={status} body={body}")
        if status == 200:
            accepted = sql(
                "SELECT total_accepted_qty FROM purchase_order_items "
                f"WHERE id = {rej_items[0]};")
            rejected_row = sql(
                "SELECT receipt_status FROM po_item_receipts "
                f"WHERE po_item_id = {rej_items[1]} ORDER BY id DESC LIMIT 1;")
            check("the accepted line records its full quantity",
                  abs(float(accepted) - 5) < 1e-6, f"accepted={accepted}")
            check("the zero-quantity line records as rejected, not dropped",
                  rejected_row == "rejected", f"status={rejected_row}")

    print("\n[13] maintenance mode freezes operations but not the account")
    sql(
        """
        INSERT INTO hr_settings (key, value) VALUES ('field_ops_app',
          '{"maintenanceMode": true}'::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
        """
    )
    status, body = api("GET", "/api/mobile/pickups", token)
    check("operations are refused with 503 during maintenance", status == 503, f"status={status}")
    check("the refusal carries a machine-readable code",
          isinstance(body, dict) and body.get("code") == "MAINTENANCE_MODE",
          f"body={body}")
    # The account surface must stay reachable so a locked rep can read the flag
    # and sign out — otherwise the app would look broken with no way to recover.
    status, me = api("GET", "/api/mobile/me", token)
    check("the account surface still answers during maintenance", status == 200, f"status={status}")
    check("the app is told maintenance is on",
          isinstance(me, dict) and me.get("app", {}).get("maintenanceMode") is True,
          f"me={me if not isinstance(me, dict) else me.get('app')}")

    sql(
        """
        INSERT INTO hr_settings (key, value) VALUES ('field_ops_app',
          '{"maintenanceMode": false}'::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
        """
    )
    status, _ = api("GET", "/api/mobile/pickups", token)
    check("operations resume once maintenance is switched off", status == 200, f"status={status}")

    return report()


def report() -> int:
    print(f"\n{'=' * 60}")
    print(f"PASSED: {len(PASS)}    FAILED: {len(FAIL)}")
    if FAIL:
        print("Failures:")
        for f in FAIL:
            print(f"  - {f}")
        return 1
    print("All end-to-end checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
