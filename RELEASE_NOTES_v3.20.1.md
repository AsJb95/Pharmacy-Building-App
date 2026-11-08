# VHC Pharmacy POS v3.20.1 – Release Notes

Patch Release of **VHC Pharmacy POS v3.20.1** delivering the verified **Low-Ink A4 Invoice Redesign** to significantly reduce printer ink and toner consumption while preserving full visual hierarchy, legal compliance, and the v3.20.0 Duplicate Billing Prevention system.

---

## Highlights & Implemented Improvements

### 1. Low-Ink A4 Invoice Redesign
- **Pure White Backgrounds**: Replaced all toner-heavy solid backgrounds with crisp white (`#ffffff`) surfaces across the entire document layout.
- **Clean Pharmacy Header**:
  - Eliminated the solid dark navy (`#13294b`) header banner.
  - Pharmacy name, GSTIN, tagline, and contact information now render in sharp dark grey/black typography (`#111827`, `#4b5563`).
  - Separated by a clean, professional border rule (`0.4mm solid #111827`).
- **Table Header & Line Item Optimization**:
  - Replaced solid navy table headers with white header cells bounded by top and bottom border rules (`0.4mm solid #111827`).
  - Completely eliminated alternating zebra striping (`#f3f6f9`), keeping all medicine rows on pure white.
  - Item dividing rules rendered with lightweight dividers (`0.25mm solid #e5e7eb`).
- **Net Amount Payable Section**:
  - Removed solid dark green (`#0f766e`) background fill.
  - Replaced with high-contrast bold dark typography, a clean top separation rule, and a classic double accounting underline (`0.5mm double #111827`).
- **Accent Lines & Information Boxes**:
  - Patient, Doctor, and Bill summary boxes now use pure white backgrounds with refined grey borders (`0.3mm solid #d1d5db`) and a subtle brand accent stripe (`0.8mm solid #0f766e`).
- **100% Data Integrity Preserved**:
  - Exact A4 dimensions (210 x 297 mm) and margins preserved.
  - All legal fields retained: Pharmacy details, GSTIN, DL numbers, Patient details, Doctor name, Invoice number & date, Payment mode, Medicine particulars, HSN, Batch, Expiry, Qty, MRP, Rate, GST %, and Totals breakdown.

### 2. Dual-Format Thermal Receipt Independence
- The 80mm / 58mm Thermal Receipt printing subsystem is completely isolated from A4 layout changes.
- Dual-format switching between `📄 A4 invoice` and `🧾 Thermal receipt` verified regression-free in live runtime testing.

### 3. Duplicate Billing Prevention & Checkout Safety (Retained from v3.20.0)
- **Synchronous Double-Click Lock**: `Complete Payment` button disables instantly on click with a processing indicator to prevent accidental duplicate clicks.
- **Migration v7 Idempotency**: Cryptographic `operationId` unique index (`idx_sales_operation_id`) prevents duplicate sales and prevents double stock deductions on network or user retries.
- **15-Minute Lookback Heuristic**: Real-time pre-flight duplicate checking for identical patient, medicines, and amounts within 15 minutes.
- **IPC Mutex Concurrency Protection**: Serializes concurrent checkout requests in the Electron main process.

---

## Installer & Release Details

| Property | Value |
| :--- | :--- |
| **Application Version** | `3.20.1` |
| **Product Name** | `VHC Pharmacy POS` |
| **Application ID** | `com.vhc.pharmacypos` |
| **Target Platform** | Windows 10 / Windows 11 (64-bit) |
| **Installer Target** | NSIS (`VHC_Pharmacy_POS_Setup_3.20.1.exe`) |
| **Previous Official Release** | `v3.20.0` (Tag: `v3.20.0`) |

---

## Release Artifacts & Checksums

| File | Size (bytes) | SHA-256 Checksum |
| :--- | :--- | :--- |
| `VHC_Pharmacy_POS_Setup_3.20.1.exe` | 110,433,621 | `871AD8FDCCB14C553A23945ECDCEABBE671D295D3D402A8921A2328A42AA177F` |
| `VHC_Pharmacy_POS_Setup_3.20.1.exe.blockmap` | 117,036 | `4D6B5E93B2B10A431C9D90CFD1D73AD43692AED736C79EDF6944B3BA259027EB` |
| Standalone `VHC Pharmacy POS.exe` | 190,695,936 | `645B5DB8293F1E9921246ACF93E6DA46DA2287EBAB7B9917B69123C92C9F7E1C` |
