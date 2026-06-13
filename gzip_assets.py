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
import os
import gzip

Import("env")  # noqa: F821 - provided by PlatformIO

data_dir = env.subst("$PROJECT_DATA_DIR") or os.path.join(  # noqa: F821
    env.subst("$PROJECT_DIR"), "data"  # noqa: F821
)


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


def main():
    if not os.path.isdir(data_dir):
        return
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
            with open(gz_path, "wb") as f:
                with gzip.GzipFile(fileobj=f, mode="wb", compresslevel=9, mtime=0) as gz:
                    gz.write(src_bytes)
            updated.append(name + ".gz")
    if updated:
        print("gzip_assets: regenerated stale ->", ", ".join(updated))
    else:
        print("gzip_assets: all .gz up to date")


main()
