# Visa Desk

A static, local-data workspace for preparing KSA ETA application details. Open the published GitHub Pages URL in Chrome on Android or a browser on a computer.

Applicant records and images are stored in that browser's IndexedDB. They are not sent to this repository or a server by the app. Each device has separate records. Export an encrypted backup with a passphrase to move data between devices or protect against browser data loss. Earlier plain JSON backups can still be imported; keep those private.

The site contains no applicant data or personal contact/address defaults. Set your own shared details in the app or import a private backup. Do not commit passport images or backup files.

For local development, run a static HTTP server from this directory, such as `python3 -m http.server 8765 --bind 127.0.0.1`, then visit `http://127.0.0.1:8765`. `node --test scan.test.mjs crypto.test.mjs` runs the scanner and backup checks.

The app prepares drafts and photos but does not fill or submit the official ETA website. Always review recognized fields against the passport.
