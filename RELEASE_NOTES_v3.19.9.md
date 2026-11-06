# VHC Pharmacy POS v3.19.9 – Release Notes

Production release of **VHC Pharmacy POS v3.19.9** featuring the complete Settings UI Redesign, Windows 11-inspired Personalization & Colors system, dynamic accent color integration, and strict theme isolation across all 12 appearance themes.

---

## Highlights & Implemented Features

### 1. Windows 11-Inspired Personalization & Colors
- **Choose Your Mode**: Rapid switching between:
  - `☀️ Light`: Clean, bright appearance (Modern Light default)
  - `🌙 Dark`: High-contrast dark styling (Modern Dark / Midnight AMOLED)
  - `💻 System Default`: Live synchronization with Windows 11 system theme (`nativeTheme.shouldUseDarkColors` and CSS `prefers-color-scheme`)
- **Transparency Effects**:
  - High-performance ON / OFF toggle.
  - When **ON**: Applies subtle Windows 11 Mica & Acrylic backdrop blur (`backdrop-filter: blur(14px) saturate(125%)`) across panels, cards, and dialogs.
  - When **OFF**: Surfaces render solid, high-contrast colors to minimize GPU usage and support low-spec hardware.
- **Accent Color Engine**:
  - **Automatic (Windows)**: Dynamically extracts the Windows 11 system accent color via Electron's `systemPreferences.getAccentColor()` and tracks real-time OS changes.
  - **Windows 11 Palette**: 8 curated colors: Windows Blue (`#0078D4`), Cobalt Cyan (`#00B7C3`), Mint Emerald (`#107C41`), Royal Indigo (`#5C2D91`), Electric Violet (`#881798`), Crimson Rose (`#E3008C`), Vermilion Orange (`#F7630C`), and Amber Gold (`#FFB900`).
  - **Custom HEX Input**: Real-time validation for 3- and 6-digit hex values, interactive HTML5 color picker (`<input type="color">`), and actionable error messaging.
  - **Recent Colors Stack**: Remembers and displays up to 5 recently applied accent colors with single-click reactivation.
- **Strict Theme Isolation**:
  - Accent colors are strictly scoped to:
    1. Active sidebar navigation (`.sidebar .nav-link.active`)
    2. Primary buttons (`.btn-primary`)
    3. Selected tabs & bill switches (`.vhc-print-opt.is-active`, `.tab.active`)
    4. Toggle switches (`input[type="checkbox"]:checked`)
    5. Focus outlines & input indicators (`:focus-visible`, `.input-field:focus`)
    6. Interactive text highlights (`.text-accent`, `.is-active`)
  - **Zero Theme Bleed**: All 12 theme backgrounds, text colors, card surfaces, and font hierarchies remain 100% untouched.
  - Switching themes preserves the active accent color, and changing accents preserves theme palettes.
- **Dynamic WCAG Contrast Calculation**:
  - Dynamic YIQ luminance calculation automatically switches text on primary buttons and active pills to dark slate (`#0f172a`) on bright accents (e.g. Amber Gold `#FFB900` or Cobalt Cyan `#00B7C3`), preventing washed-out white text.
- **Zero-Flash Bootstrap**:
  - Head bootstrap script in `index.html` resolves and injects CSS variables before initial DOM paint, preventing white/dark flash on startup.

### 2. Settings UI Modernization & Unified Dashboard
- **Structured Layout Hierarchy**:
  1. `🎨 Appearance`: Compact active theme summary pill with expandable 12-theme gallery on demand.
  2. `✨ Personalization & Colors`: Dedicated Windows 11 customization hub.
  3. `🖨️ Printing Preferences`: Instant toggle between 80mm thermal receipt and full A4 invoice format.
  4. `⌨️ Shortcuts & Accessibility`: Retained complete keyboard navigation and accessibility options.
  5. `🛡️ Admin Controls`: Unified single-password unlock gateway with Enter key support; unlocks complete Admin Dashboard with widgets for Stock Audit, Gemini AI, Stock Admin, Backup & Restore, and Danger Zone.
  6. `🏫 Pharmacy Details`: Minimizable store identity and legal documentation section.
  7. `⚙️ General Configuration`: Collapsible cloud sync, Telegram bot, and privacy settings.
  8. `ℹ️ App Details / About`: Software version, database schema, and license details at page footer.

### 3. Preserved Core Systems & Security Hardening
- **Zero Schema or Business Logic Changes**: Inventory ledger, POS billing, local SQLite database, and Supabase cloud sync operations remain 100% identical.
- **Admin Password Gate**: Session-based unlock requiring password authentication only once per session, with explicit session lock and uppercase `DELETE` confirmation for destructive actions.
- **Google Gemini Scanner**: Secure encrypted storage (`safeStorage` / DPAPI), centralized model resolution to `gemini-2.5-flash`, multi-format key sanitization, and human review gate.

---

## Installer & Release Details

| Property | Value |
| :--- | :--- |
| **Application Version** | `3.19.9` |
| **Product Name** | `VHC Pharmacy POS` |
| **Application ID** | `com.vhc.pharmacypos` |
| **Target Platform** | Windows 10 / Windows 11 (64-bit) |
| **Installer Target** | NSIS (`VHC_Pharmacy_POS_Setup_3.19.9.exe`) |
| **Previous Official Release** | `v3.19.8` (Tag: `v3.19.8`) |

---

## Release Artifacts & Checksums

| File | Size (bytes) | SHA-256 Checksum |
| :--- | :--- | :--- |
| `VHC_Pharmacy_POS_Setup_3.19.9.exe` | 110,431,464 | `51F3E6974924DCC2C49C274AE32AFED0CEAFA54CE9431F4BA1FCDB5238A3D02B` |
| `VHC_Pharmacy_POS_Setup_3.19.9.exe.blockmap` | 117,042 | `A73D12236B99882116F99EE36679445F186E2B382AE12E6D7ED8298DDB1AD25E` |
| Packaged `app.asar` | 161,878,084 | `AF400E512C2392339A02CF2DF6399136D81BA2DD455BB496FDC19A39B6F3F62D` |
| Standalone `VHC Pharmacy POS.exe` | 190,695,936 | `58C62273703D9BFB1F1F847DA8E7F31F5ECB1B8655DE538D84941F3EFFA16ECF` |

