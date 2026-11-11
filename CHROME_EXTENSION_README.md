# Visa Desk for Google Chrome

Visa Desk runs as a desktop Chrome Manifest V3 extension. Click its toolbar icon to open the full workspace. Python and a web server are not needed to use the extension. Passport OCR, PDF reading and photo preparation are bundled and run offline.

## Install

1. Open `chrome://extensions` in desktop Google Chrome.
2. Enable **Developer mode** in the upper right.
3. Click **Load unpacked** and select this project's `dist/visa-desk-extension` folder (the folder containing `manifest.json`).
4. Open Chrome's puzzle-piece menu and pin **Visa Desk**. Click its icon to open it.

The ready-to-use package is `dist/visa-desk-chrome.zip`. To install on another computer, extract that ZIP into a permanent folder, then load that folder using the steps above. Chrome does not install this ZIP by dragging it into a tab. Keep the unpacked folder in place after installation. This package has not been published to the Chrome Web Store.

Alternatively, load the repository root folder directly while developing. Build the clean distributable again with `python build_extension.py`. The build uses an explicit allowlist and excludes applicant records, samples, images from `assets`, local databases, node_modules and backup files.

Desktop Chrome is supported; Android Chrome cannot load desktop extensions. Use the existing web app on Android, with manual backup transfer.

## Bring your existing data

In the existing Visa Desk web app or another Visa Desk extension, choose **Export backup**, enter and confirm a passphrase of at least 12 characters, and save the encrypted JSON file. In this extension, click **Import data**, select that file, and enter the passphrase. The preview shows the number of applicants, history records and unassigned photos before changing anything.

- **Merge records** keeps current applicants and shared defaults. Identical records with the same ID are skipped. Changed copies with the same ID are retained as separate records so neither version is overwritten. Review these copies manually.
- **Replace workspace** restores the backup's applicants, images, history, unassigned photos and defaults. A confirmation appears if there is existing data. Export anything you need before replacing it.

The same encrypted backup format works between Visa Desk extension installations, Chrome profiles, devices and the web app. Earlier plain Visa Desk JSON backups also import. The original Python app's **Export batch JSON** imports applicant details, but its filesystem paths cannot bring images into an extension; attach those images separately. Private converted web backups with embedded images can also be imported; no private samples are included in this repository.

Imports from unrelated extensions need a converter for their particular format. This extension cannot silently read another extension's private storage. There is no automatic cross-extension sharing.

## Everyday use

Set **Shared details**, then add applicants or import passport images/PDFs. Verify recognized fields against the passport. Import and manually assign headshots; prepare the 35 × 45 photo and download copies for the official form. Mark an applicant as submitted only after submitting them yourself. History can create another draft.

The toolbar button focuses an existing Visa Desk tab when possible. Edits save locally as you type. Keep the tab open while a scan or import runs. The extension prepares drafts and documents; the authenticated KSA form is not mapped, so it does not autofill, upload, submit or pay.

## Where data lives

Applicant records and embedded images live in IndexedDB inside the extension's local Chrome profile. They are not stored in Chrome Sync, sent to a backend, or copied to another installation automatically. The only extension permission is `unlimitedStorage`, for local document storage. The package has no host permissions, content scripts, external messaging or analytics. Its content security policy blocks external fetches and remote code; scanner code, WebAssembly and language data are bundled. Opening the official ETA page deliberately opens that website in a separate tab.

Local IndexedDB is **not encrypted by this app**. Backup files use AES-256-GCM with a passphrase-derived key. Protect your Windows account and Chrome profile, store exports privately, and keep passphrases separately. Exporting into a cloud-synced Downloads folder can sync that file through your own OS/browser setup; choose a local folder if you want it to stay on the device.

Uninstalling the extension, deleting the Chrome profile or removing its extension data can erase records. Moving an unpacked extension to a different folder can give it a new extension ID and separate storage. Keep a permanent installation folder; export before moving, reinstalling or updating. Update in place, then use **Reload** on `chrome://extensions`.

## Validation

Run `npm test` from the repository root (or `node --test scan.test.mjs crypto.test.mjs transfer.test.mjs extension.test.mjs` from the project root). Tests cover MRZ checks, encrypted round trips, transfer completeness, safe imports, merge conflicts and extension permissions/CSP.

`extension_smoke.mjs` additionally checks a real loaded extension in isolated Chromium profiles: adjacent field editing and reload, offline OCR, PDF rendering, photo cropping, encrypted backup transfer, bad passphrases, malformed imports, history/images/defaults, responsive layout and absence of external requests or CSP errors. It requires Playwright and a Chromium build that supports command-line unpacked extension loading. Set `PLAYWRIGHT_MODULE` to Playwright's `index.mjs` if it is not installed locally, and `CHROMIUM_EXECUTABLE` to that browser executable, then run `node extension_smoke.mjs`. The test uses synthetic records, deletes its temporary profiles, and saves a screenshot in `dist/extension-preview.png`.
