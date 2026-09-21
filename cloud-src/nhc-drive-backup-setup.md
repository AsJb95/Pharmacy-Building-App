# NHC Drive isolation: manual configuration and deployment

Status: source and mock tests only. No folder or deployment has been created.
Do not launch the unsafe installed NHC 3.18.2 to configure or test this work.

## Manual steps for the next authorized phase

1. In the intended NHC Google account, create a **new, empty, private** folder named `NHC Pharmacy POS Backups`. Do not reuse any existing shared application backup folder. Copy its folder link and ID.
2. At https://script.google.com create a new standalone project named `NHC Pharmacy Backup`. Copy `nhc-drive-backup.gs` into its editor, replacing the default code. Do not edit the existing deployment.
3. Generate a fresh, random secret of at least 32 characters using a password manager (recommended: 64 random hexadecimal characters). Keep it private. Do not put it in source, Git, URLs, screenshots or logs.
4. In **Project Settings → Script Properties**, set `NHC_DRIVE_FOLDER_ID` to the new folder ID and `NHC_BACKUP_ACCESS_TOKEN` to the secret. No defaults are provided. The client folder must match this property exactly.
5. Choose **Deploy → New deployment → Web app**. Execute as the NHC account that owns the folder. For the current desktop POST protocol choose **Who has access: Anyone**; every action independently requires the secret in its POST body. This makes the endpoint reachable, not the backup data public. If organizational policy disallows this, stop and choose a separately reviewed authenticated hosting approach; do not remove the script's authentication checks. Authorize the required Drive access and copy the new `/exec` URL, not `/dev`.
6. In the future isolated fixed NHC build/profile, open Settings → Backup & Restore → Google Drive → NHC Apps Script Sync. Enter the new folder link, new deployment URL, and access token in the NHC-specific fields. These store `nhcGoogleDriveUrl`, `nhcGDriveScriptUrl`, `nhcGDriveAccessToken`. Legacy fields are ignored. Use the same new folder for optional direct Google OAuth operations.
7. Only after separate live-test authorization, use synthetic NHC data to upload twice and verify one updated auto-backup file, then create a manual backup. Verify list/restore, wrong-identity rejection and out-of-folder rejection. Confirm the existing other-application folder is unchanged. Never use production restore as a smoke test.
8. Resolve the release metadata discrepancy, set all release metadata consistently to 3.18.3, build into a new output folder, inspect the packaged files and run an isolated 3.18.2 → 3.18.3 upgrade test before recommending live installation.

Google references: [Web app deployment](https://developers.google.com/apps-script/guides/web), [Script Properties](https://developers.google.com/apps-script/guides/properties), [Drive file operations](https://developers.google.com/apps-script/reference/drive/file).

## Protocol and isolation rules

All operations use JSON POST (`Content-Type: text/plain`) containing `action`, `folderId`, `accessToken`. GET HTTP requests return an error without data. Actions are `upload` (`fileName`, `fileContent`), `list`, and `get` (`fileId`). The server folder is fixed by Script Properties; a client cannot choose another folder. The server accepts only `NHC_POS_[A-Za-z0-9_-]+.json`, maximum 180 characters; path-like filenames are rejected.

Every uploaded/read backup must have `backupNamespace: "NHC_PHARMACY_POS"`, or absent namespace with exact legacy `appName: "NHC Pharmacy POS"`. Explicit conflicting namespace or application name is rejected. Arrays and settings have basic schema checks. Lists omit incompatible files without deleting them. Get checks immediate parent membership, filename, trash/shortcut state and content identity. Upload locks the script, searches only the configured folder for the exact supplied filename, validates any existing file before updating it, and rejects duplicate-name ambiguity. No server delete, rotation, folder creation, or global filename lookup exists. Content is limited to 20 million characters; platform quotas may impose lower practical limits.

The desktop independently validates filenames and downloaded identity. Direct OAuth operations recheck folder membership, name and content before restore, download or deletion. Local rotation keeps five NHC-named backups and never rotates other filename prefixes. Local imports also require NHC identity; unidentified legacy files and other-application backups need a separately reviewed migration workflow.

The access token is held in the device's existing settings store, masked in the UI and excluded (with all Drive connection settings) from generated backups. Restores preserve the device's current NHC Drive connection settings. This is a bearer secret; access to the local profile can expose it. Revoke by changing the Script Property and then updating authorized NHC devices. Keep the folder private and limit script editors. Folder ownership and correct manual configuration cannot be proven by a filename/namespace alone.

## Version discrepancy

At the start of this phase, committed `package.json` and lockfile root metadata are 3.18.1. The installed application is reported as 3.18.2 and an untracked installer is named 3.18.2. The repository metadata was not advanced to that value. The exact build/packaging procedure behind that installer has not been established; its filename is not evidence of the current source version. No version bump is part of this phase.

## Historical repair tool

`repair_null_mrp.cjs` is unchanged VHC-baseline maintenance tooling, including its original backup path and database project. It is not an NHC backup runtime path and must not be run for NHC maintenance by merely changing its input path. It was not executed in this work.
