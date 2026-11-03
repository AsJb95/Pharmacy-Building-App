# VHC Pharmacy POS v3.19.8 — Release Notes

Production release of VHC Pharmacy POS v3.19.8 combining the complete Inventory redesign, Gemini AI Scanner enhancements, 12 appearance themes, print formatting preferences, and administrative backup & security hardening.

## Highlights & Implemented Features

### 1. Comprehensive Inventory Redesign & Status Filtering
- **6 Inventory Status Cards**: Interactive summary cards for **All**, **Out of Stock**, **Critical**, **Low Stock**, **Expiring**, and **Expired** with instant single-click filtering and reset capability.
- **Accurate Count Display**: Batch counts displayed above the table synchronize instantly with filter selections and active search terms.
- **Stock Movements & Ledger Integrity**: Atomic deductions and restock auditing; warehouse-to-pharmacy transfer reconciliation.

### 2. Gemini AI & Scanner Configuration
- **Secure Encrypted Storage**: API keys encrypted at rest using Windows DPAPI (`safeStorage`). Raw keys are never returned in plaintext to the renderer.
- **Multi-Format Key Sanitization**: Robust handling of copied keys, trimming whitespace, surrounding quotes/backticks, environment variable prefixes (`GEMINI_API_KEY=`, `GOOGLE_API_KEY=`), and URL query parameters.
- **Centralized Model Configuration**: Configured and validated against Google Gemini endpoints (`gemini-2.5-flash`, `gemini-2.0-flash`). Hardcoded legacy fallbacks to deprecated `gemini-1.5-flash` eliminated.
- **Invoice & Prescription Scanning**: Intelligent batch, expiry, MRP, and pack size calculation with staged review prior to inventory commit.
- **Test Connection & Actionable Feedback**: Pre-flight verification of `generateContent` support with specific error messages for quota exhaustion or unsupported models.

### 3. Settings & Appearance Modernization
- **12 Curated Themes**: Added support for 12 complete theme palettes (System Default, Modern Light, Modern Dark, Midnight, Classic Light, High Contrast, Ocean Blue, Glassmorphism, Emerald, Soft Lavender, Nordic, Warm Sand).
- **Zero-Flash Bootstrap**: Theme resolution executed before initial DOM paint in `index.html`.
- **Accessible Contrast**: Form controls, inputs, and dropdown options optimized for high-contrast readability across all palettes.

### 4. Printing & Layout Preferences
- **Flexible Print Layouts**: Support for 80mm thermal receipts and full A4 invoice previews with user-selectable default formats.
- **Live Preview Modals**: Enhanced bill preview rendering directly from sales history and receipt generation workflows.

### 5. Admin Backup & Restore v2
- **AES-256-GCM Encrypted Drive Backups**: Automated and manual database snapshots encrypted with authenticated DPAPI recovery key generation.
- **Cloud Verification & Checksums**: Integrity checks against Google Drive file checksums before recording success.
- **Role-Aware Security**: Admin password gated restore workflows preventing unintended data overwrites.

---

## Release Artifacts & Checksums

| File | Size (bytes) | SHA-256 Checksum |
| :--- | :--- | :--- |
| `VHC_Pharmacy_POS_Setup_3.19.8.exe` | 110,014,336 | `F08F22F3F9B68E8F23916E977748A8AF1AF55367568E65F03FA2B820F99304C4` |
| `VHC_Pharmacy_POS_Setup_3.19.8.exe.blockmap` | 116,288 | `CF134C442CFB208D0D13C3D3D501ECB25E1C2F0F97A9DF0516CC49345D87D200` |
| Packaged `app.asar` | 159,262,299 | `6C143485281AC96FA4585E90268F41E2B00826894451EAC110411B2644E516FB` |
