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

# Repo this build came from, normalised to a github.com https URL (no .git), so
# the UI can default the "Update from GitHub" field to the right place.
try:
    repo = subprocess.check_output(
        ["git", "config", "--get", "remote.origin.url"],
        text=True, stderr=subprocess.DEVNULL
    ).strip()
except Exception:
    repo = ""
if repo.startswith("git@github.com:"):
    repo = "https://github.com/" + repo[len("git@github.com:"):]
if repo.endswith(".git"):
    repo = repo[:-4]
env.Append(CPPDEFINES=[("WEB_REPO", env.StringifyMacro(repo))])

# OTA asset name prefix for this build target, so the UI can pre-select the
# matching <prefix>_<ver>-ota.bin and avoid flashing the wrong board's image.
# Named by chip architecture (matches the /settings `arch` field). The UI
# aliases the older esp32_wemos / esp32_t2can names to these.
pioenv = env["PIOENV"]
target = "esp32s3" if "t2can" in pioenv else "esp32"
env.Append(CPPDEFINES=[("WEB_OTA_TARGET", env.StringifyMacro(target))])

print("WEB_VERSION:", ver, "| WEB_REPO:", repo, "| WEB_OTA_TARGET:", target)
