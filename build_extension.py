"""Build a data-free, unpacked Chrome extension and a ZIP using only stdlib."""
from pathlib import Path
import shutil
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web" if (ROOT / "web").is_dir() else ROOT
FILES = ["manifest.json", "index.html", "styles.css", "icon.svg", "manifest.webmanifest",
         "app.mjs", "storage.mjs", "mrz.mjs", "crypto.mjs", "transfer.mjs"]


def build():
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    target = dist / "visa-desk-extension"
    # Explicit allowlist: never package assets, samples, databases or backups.
    files = [WEB / name for name in FILES]
    for directory in [WEB / "extension", WEB / "vendor"]:
        files.extend(path for path in directory.rglob("*") if path.is_file())
    with tempfile.TemporaryDirectory(prefix="extension-build-", dir=dist) as temp:
        staging = Path(temp) / "package"
        for source in files:
            destination = staging / source.relative_to(WEB)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        # Only replace this generated output directory within this workspace.
        if target.resolve().parent != dist.resolve() or target.name != "visa-desk-extension":
            raise ValueError("Unexpected build output path")
        if target.is_symlink():
            raise ValueError("Build output must not be a symlink")
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(staging, target)
        archive = dist / "visa-desk-chrome.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
            for source in files:
                output.write(source, source.relative_to(WEB).as_posix())
    print(f"Chrome Load unpacked folder: {target}")
    print(f"Portable extension ZIP: {archive} ({archive.stat().st_size:,} bytes)")
    print("No applicant records, images, samples or local databases included.")


if __name__ == "__main__":
    build()
