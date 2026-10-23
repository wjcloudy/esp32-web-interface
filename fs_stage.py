# Stages the filesystem image's contents: a copy of data/ in .pio/fsdata
# without the raw sources that have a .gz twin, and points buildfs/uploadfs
# at it. The ESP always serves <file>.gz when it exists (handleFileRead), so
# a raw twin on SPIFFS is never read - it only took space (~580 KB of the
# default partition's ~1.4 MB: app.js alone is ~400 KB raw). data/ itself is
# untouched: the demo, the E2E mock and the tests still use the sources.
#
# Runs as a pre-script after gzip_assets.py, so the .gz twins it copies are
# already fresh. The copy is rebuilt on every pio invocation (it's ~0.5 MB).
import os
import shutil

Import("env")  # noqa: F821 - provided by PlatformIO

src = env.subst("$PROJECT_DATA_DIR") or os.path.join(env.subst("$PROJECT_DIR"), "data")  # noqa: F821
dst = os.path.join(env.subst("$PROJECT_DIR"), ".pio", "fsdata")  # noqa: F821

if os.path.isdir(src):
    shutil.rmtree(dst, ignore_errors=True)
    skipped = 0

    def ignore(folder, names):
        global skipped
        out = [n for n in names if not n.endswith(".gz") and n + ".gz" in names
               and os.path.isfile(os.path.join(folder, n))]
        skipped += sum(os.path.getsize(os.path.join(folder, n)) for n in out)
        return out

    shutil.copytree(src, dst, ignore=ignore)
    env.Replace(PROJECT_DATA_DIR=dst)  # noqa: F821
    print("fs_stage: SPIFFS image from .pio/fsdata (%d KB of raw twins left out)" % (skipped // 1024))
