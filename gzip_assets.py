# Regenerates data/*.gz from their source files before the filesystem image is
# built, so the gzip the ESP serves (and that buildfs/uploadfs packs into SPIFFS)
# can never go stale. Runs as a pre-script for every pio invocation, so it
# protects both local `pio uploadfs` and the CI release build.
#
# Only files that already have a committed <name>.gz twin are managed, and a
# .gz is rewritten only when its decompressed content no longer matches the
# source. That means: no spurious git diffs when everything is already in sync,
# automatic regeneration when a source was edited without refreshing its .gz,
# and gz-only assets (e.g. chart.min.js.gz, with no raw source) are left alone.
#
# Also runs standalone (no PlatformIO):
#   python gzip_assets.py            regenerate stale .gz twins in place
#   python gzip_assets.py --check    verify only; exit 1 if any .gz is stale
#                                    (used as a CI gate so commits can't ship
#                                    a data/ edit without its .gz twin)
import os
import gzip
import sys

try:
    Import("env")  # noqa: F821 - provided by PlatformIO
    IS_PIO = True
    data_dir = env.subst("$PROJECT_DATA_DIR") or os.path.join(  # noqa: F821
        env.subst("$PROJECT_DIR"), "data"  # noqa: F821
    )
except NameError:  # standalone invocation
    IS_PIO = False
    data_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


def canonical(path):
    """Source bytes normalised to LF so the gzip is identical on every
    platform regardless of git's autocrlf line-ending conversion."""
    with open(path, "rb") as f:
        return f.read().replace(b"\r\n", b"\n")


def stale(src_path, gz_path):
    """Return (needs_rewrite, canonical_source_bytes)."""
    target = canonical(src_path)
    try:
        with gzip.open(gz_path, "rb") as f:
            current = f.read()
    except OSError:
        return True, target  # missing/corrupt .gz
    return current != target, target


def main(check_only=False):
    if not os.path.isdir(data_dir):
        return 0
    updated = []
    for name in sorted(os.listdir(data_dir)):
        if name.endswith(".gz"):
            continue
        src_path = os.path.join(data_dir, name)
        gz_path = src_path + ".gz"
        if not os.path.isfile(src_path) or not os.path.isfile(gz_path):
            continue  # only manage files that already have a .gz twin
        needs_rewrite, src_bytes = stale(src_path, gz_path)
        if needs_rewrite:
            if not check_only:
                with open(gz_path, "wb") as f:
                    with gzip.GzipFile(fileobj=f, mode="wb", compresslevel=9, mtime=0) as gz:
                        gz.write(src_bytes)
            updated.append(name + ".gz")
    if check_only:
        if updated:
            print("gzip_assets: STALE ->", ", ".join(updated))
            print("Run `python gzip_assets.py` (or any pio build) to regenerate, then commit the .gz files.")
            return 1
        print("gzip_assets: all .gz up to date")
        return 0
    if updated:
        print("gzip_assets: regenerated stale ->", ", ".join(updated))
    else:
        print("gzip_assets: all .gz up to date")
    return 0


if IS_PIO:
    main()  # always regenerate as part of a build, exactly as before
else:
    sys.exit(main(check_only="--check" in sys.argv))
