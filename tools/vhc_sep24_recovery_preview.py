import base64
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone


SUPABASE_URL = "https://yrgtnhvnwkqudxdcrkhm.supabase.co"
ANON_KEY = "sb_publishable_7fL9ZcI18hC1XiMqeCLhlg_YXNzABAC"
PROFILE = os.environ.get("VHC_PROFILE_PATH", r"C:\Users\arunk\AppData\Roaming\vhc-pharmacy-pos")
OUT_DIR = os.environ.get("VHC_RECOVERY_OUT", r"C:\New VHC\VHC Pharmacy\evidence_v3181_prod_20260924_225255")
START_UTC = "2026-09-23T18:30:00.000Z"
END_UTC = "2026-09-24T18:30:00.000Z"


def _payload(token):
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        return json.loads(base64.urlsafe_b64decode(part.encode("ascii")))
    except Exception:
        return {}


def _tokens(profile):
    pat = re.compile(rb"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
    found = {}
    leveldb = os.path.join(profile, "Local Storage", "leveldb")
    for root, _, files in os.walk(leveldb):
        for name in files:
            if not name.endswith((".ldb", ".log")):
                continue
            try:
                raw = open(os.path.join(root, name), "rb").read()
            except OSError:
                continue
            for m in pat.finditer(raw):
                tok = m.group(0).decode("ascii", "ignore")
                p = _payload(tok)
                if "supabase" in str(p.get("iss", "")).lower():
                    found[tok] = p
    return found


def _get(path, params, token):
    url = SUPABASE_URL + path
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True, safe=",:.*()")
    req = urllib.request.Request(
        url,
        headers={
            "apikey": ANON_KEY,
            "Authorization": "Bearer " + token,
            "Accept": "application/json",
            "Prefer": "count=exact",
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        body = res.read().decode("utf-8", "replace")
        return res.status, dict(res.headers), json.loads(body) if body else None


def _chunks(values, size=80):
    for i in range(0, len(values), size):
        yield values[i:i + size]


def _local_bill_ids(profile):
    ids = set()
    leveldb = os.path.join(profile, "Local Storage", "leveldb")
    for root, _, files in os.walk(leveldb):
        for name in files:
            if not name.endswith((".ldb", ".log")):
                continue
            try:
                txt = open(os.path.join(root, name), "rb").read().decode("utf-8", "ignore")
            except OSError:
                continue
            ids.update(re.findall(r"BILL-\d+", txt))
    return ids


def _round(n):
    return round(float(n or 0), 2)


def _payment_fields(sale):
    mode = sale.get("payment_mode") or "Cash"
    total = float(sale.get("total_amount") or 0)
    amount_received = sale.get("amount_received")
    outstanding = sale.get("outstanding_amount")
    status = sale.get("payment_status")
    breakdown = sale.get("payment_breakdown") or sale.get("paymentBreakdown")
    if isinstance(breakdown, str):
        try:
            breakdown = json.loads(breakdown)
        except Exception:
            breakdown = None
    if not isinstance(breakdown, dict):
        if mode == "Credit":
            breakdown = {"credit": total}
        elif mode == "Split":
            breakdown = {"unspecified": total}
        else:
            breakdown = {mode: total}
    if amount_received is None:
        amount_received = 0 if mode == "Credit" else total
    if outstanding is None:
        outstanding = total if mode == "Credit" else 0
    if not status:
        status = "Credit" if mode == "Credit" else "Paid"
    return _round(amount_received), _round(outstanding), status, breakdown


def _map_bill(sale, items):
    amount_received, outstanding, status, breakdown = _payment_fields(sale)
    particulars = []
    for it in items:
        meta = it.get("metadata") or {}
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except Exception:
                meta = {}
        particulars.append({
            "category": it.get("category") or "Medicine",
            "drugName": it.get("drug_name") or meta.get("medicineName") or "",
            "batchNo": it.get("batch_no") or "N/A",
            "expiryDate": it.get("expiry_date") or "N/A",
            "quantity": it.get("quantity") or 0,
            "rate": it.get("rate") or 0,
            "total": it.get("total") or 0,
            **meta,
        })
    return {
        "billId": sale.get("bill_id"),
        "date": sale.get("sale_date") or sale.get("created_at"),
        "patientName": sale.get("patient_name") or "Walk-in Patient",
        "patientId": sale.get("patient_id") or "",
        "patientSnapshot": None,
        "doctorName": sale.get("doctor_name") or "",
        "paymentMode": sale.get("payment_mode") or "Cash",
        "subtotal": sale.get("subtotal") or 0,
        "totalTax": sale.get("total_tax") or 0,
        "totalAmount": sale.get("total_amount") or 0,
        "gstMode": sale.get("gst_mode") or "regular",
        "discount": sale.get("discount") or 0,
        "discountPercent": sale.get("discount_percent") or 0,
        "amountReceived": amount_received,
        "outstandingAmount": outstanding,
        "paymentStatus": status,
        "paymentBreakdown": breakdown,
        "recordedBy": sale.get("recorded_by"),
        "particulars": particulars,
        "fromCloudRecoveryPreview": True,
        "cloudSaleId": sale.get("id"),
    }


def main():
    now = int(datetime.now(timezone.utc).timestamp())
    valid = [(t, p) for t, p in _tokens(PROFILE).items() if isinstance(p.get("exp"), int) and p["exp"] > now + 60]
    if not valid:
        print(json.dumps({"ok": False, "error": "AUTHENTICATED_CLOUD_CHECK_BLOCKED", "profile": PROFILE}, indent=2))
        return 2
    token, payload = sorted(valid, key=lambda x: x[1]["exp"], reverse=True)[0]
    status, headers, sales = _get("/rest/v1/sales", {
        "select": "*",
        "sale_date": [f"gte.{START_UTC}", f"lt.{END_UTC}"],
        "order": "sale_date.asc",
    }, token)
    if status not in (200, 206) or not isinstance(sales, list):
        print(json.dumps({"ok": False, "error": "sales query failed", "status": status}, indent=2))
        return 3
    sale_ids = [s["id"] for s in sales if s.get("id")]
    items = []
    for chunk in _chunks(sale_ids):
        s, _, rows = _get("/rest/v1/sale_items", {"select": "*", "sale_id": f"in.({','.join(chunk)})"}, token)
        if s in (200, 206) and isinstance(rows, list):
            items.extend(rows)
    by_sale = defaultdict(list)
    for it in items:
        by_sale[it.get("sale_id")].append(it)
    local_ids = _local_bill_ids(PROFILE)
    mapped = []
    conflicts = []
    missing = []
    for sale in sales:
        bid = sale.get("bill_id")
        sale_items = by_sale.get(sale.get("id"), [])
        if not bid:
            missing.append({"sale_id": sale.get("id"), "reason": "missing bill_id"})
            continue
        if bid in local_ids:
            conflicts.append({"billId": bid, "reason": "already present locally"})
            continue
        if not sale_items:
            missing.append({"billId": bid, "sale_id": sale.get("id"), "reason": "missing sale_items"})
            continue
        mapped.append(_map_bill(sale, sale_items))
    mode_summary = Counter(b["paymentMode"] for b in mapped)
    out = {
        "ok": True,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "readOnly": True,
        "source": {
            "supabaseHost": urllib.parse.urlparse(SUPABASE_URL).hostname,
            "startUtc": START_UTC,
            "endUtc": END_UTC,
            "sessionExpiresUtc": datetime.fromtimestamp(payload["exp"], timezone.utc).isoformat(),
        },
        "before": {"localBillIdCount": len(local_ids), "localBillIds": sorted(local_ids)},
        "cloud": {"salesCount": len(sales), "saleItemsCount": len(items)},
        "preview": {
            "recoverableCount": len(mapped),
            "afterLocalBillIdCount": len(local_ids) + len(mapped),
            "totalAmount": _round(sum(float(b.get("totalAmount") or 0) for b in mapped)),
            "paymentModeSummary": dict(mode_summary),
            "duplicatePreviewBillIds": sorted([b for b, c in Counter(b["billId"] for b in mapped).items() if c > 1]),
        },
        "conflicts": conflicts,
        "missingOrUnsafe": missing,
        "recoveredBillsPreview": mapped,
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, "vhc_sep24_recovery_preview_READ_ONLY.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(json.dumps({
        "ok": True,
        "written": path,
        "salesCount": len(sales),
        "saleItemsCount": len(items),
        "recoverableCount": len(mapped),
        "totalAmount": out["preview"]["totalAmount"],
        "paymentModeSummary": out["preview"]["paymentModeSummary"],
        "conflicts": len(conflicts),
        "missingOrUnsafe": len(missing),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
