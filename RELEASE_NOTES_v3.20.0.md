# VHC Pharmacy POS v3.20.0 – Release Notes

Release Candidate of **VHC Pharmacy POS v3.20.0** featuring the comprehensive **Duplicate Billing Prevention & Checkout Safety** system, Migration v7 SQLite idempotency, IPC race-condition locking, and intelligent 15-minute duplicate bill detection.

---

## Highlights & Implemented Features

### 1. Duplicate Billing Prevention & Checkout Safety
- **Double-Click Protection**:
  - Synchronous DOM disabling on the **Complete Payment** button immediately upon the first click or shortcut trigger (F8 / Ctrl+P).
  - High-visibility animated processing spinner (`Processing Payment...`) preventing operator double-submitting.
  - Safe unlocking if client-side validation fails or if local database throws an error.
- **Idempotency Protection (Migration v7)**:
  - Generates a cryptographically strong, stable `operationId` before initiating checkout.
  - Added `operation_id TEXT` column to the `sales` table with a partial unique index:
    `CREATE UNIQUE INDEX idx_sales_operation_id ON sales (operation_id) WHERE operation_id IS NOT NULL;`
  - Replaying checkout with the same `operationId` returns `{ success: true, duplicate: true }` without inserting a second sale row or deducting stock twice.
  - Existing historical sales created prior to v3.20.0 (where `operation_id` is `NULL`) remain fully intact without unique constraint violations.
- **IPC Concurrency Mutex**:
  - In-flight promise locking in `electron/main.js` (`activeCheckoutIpcLocks`) keyed by `op:<operationId>` and `bill:<billId>`.
  - Multiple concurrent IPC checkout calls within the same event-loop tick are serialized, returning the result of the primary transaction.
- **15-Minute Lookback Heuristic & Warning Modal**:
  - Real-time pre-flight query (`getRecentSalesForDuplicateCheck`) checks whether the same patient was billed within the past 15 minutes.
  - Evaluates matching medicines, identical batches, and similar totals (within 5% or ₹5).
  - If a potential duplicate is detected, a high-contrast modal alerts the operator:
    1. **"Review Previous Bill"** (Primary accent): Opens the previous bill details for immediate verification.
    2. **"Continue New Billing (Legitimate)"** (Secondary outline): Allows an intentional subsequent purchase to proceed under fresh unique transaction IDs.
    3. **"Cancel Checkout"** (Ghost): Closes the warning dialog safely.
- **Exactly-Once Stock & Payment Guarantees**:
  - Rigorously audited across single-item, multi-item, and split-payment transactions (Cash + UPI).
  - Overselling prevented: concurrent transactions for limited inventory evaluate stock atomically at the database boundary.

### 2. Preserved v3.19.9 Personalization & Settings Features
- **Windows 11-Inspired Personalization**: Choose Your Mode (Light, Dark, System Default), Transparency Effects (Mica & Acrylic), Windows 11 accent color palette, dynamic WCAG contrast calculation, and strict theme isolation across all 12 appearance themes.
- **Unified Settings UI**: Compact appearance pill, dedicated printing preferences (Thermal 80mm vs. A4 invoice), shortcuts, and unified Admin Dashboard.
- **Security Hardening**: Unified password unlock gateway, zero hardcoded credentials, and DPAPI-encrypted Google Gemini scanner API key storage.
- **Offline-First Resilience**: All billing transactions execute locally in SQLite first; background synchronization dispatches confirmed sales to Supabase when network is reachable.

---

## Installer & Release Details

| Property | Value |
| :--- | :--- |
| **Application Version** | `3.20.0` |
| **Product Name** | `VHC Pharmacy POS` |
| **Application ID** | `com.vhc.pharmacypos` |
| **Target Platform** | Windows 10 / Windows 11 (64-bit) |
| **Installer Target** | NSIS (`VHC_Pharmacy_POS_Setup_3.20.0.exe`) |
| **Previous Official Release** | `v3.19.9` (Tag: `v3.19.9`) |

---

## Release Artifacts & Checksums

| File | Size (bytes) | SHA-256 Checksum |
| :--- | :--- | :--- |
| `VHC_Pharmacy_POS_Setup_3.20.0.exe` | 110,433,593 | `297981E25578463C83D98CB86653A471BB01E6F5BB550248FA296AA35DBC7104` |
| `VHC_Pharmacy_POS_Setup_3.20.0.exe.blockmap` | 116,944 | `CBC53DC7A21E86BF91ECCA018AC5D8FAB1AD1C2CB44A6643A5B3B4A570CF5A89` |
| Packaged `app.asar` | 161,893,607 | `E68D70594359E3F6C32F42DCE2FD7C58D31D267928EF4EE3024B5C8E3925D1A9` |
| Standalone `VHC Pharmacy POS.exe` | 190,695,936 | `17C4BF9892E10A46F8226CFEA9FABBCAEA7ADE6C70ED8B5F6F159533D6C76066` |
