# Injects the git-derived version (tag, or tag-distance-sha) as WEB_VERSION
# so firmware, UI and release artifacts all report the same version.
import subprocess

Import("env")

try:
    ver = subprocess.check_output(
        ["git", "describe", "--tags", "--always", "--dirty"],
        text=True, stderr=subprocess.DEVNULL
    ).strip()
except Exception:
    ver = "unknown"

env.Append(CPPDEFINES=[("WEB_VERSION", env.StringifyMacro(ver))])
print("WEB_VERSION:", ver)
