"""Supply firmware and espota secrets without committing passwords."""
import configparser
import json
import os
import shlex
from pathlib import Path

Import("env")
root = Path(env.subst("$PROJECT_DIR"))
config = configparser.ConfigParser(interpolation=None)
config.read(root / "platformio.private.ini")

def setting(name):
    return os.environ.get("DYNO_" + name.upper(), config.get("dyno", name, fallback=""))

ota = setting("ota_password")
setup = setting("setup_password")
origins = setting("extra_origins")
if setup and not 8 <= len(setup) <= 63:
    raise ValueError("setup_password must be 8-63 characters")
if ota == "replace-with-a-strong-private-password":
    raise ValueError("Replace the example OTA password with your own password")
generated = root / ".pio" / "generated" / env.subst("$PIOENV")
generated.mkdir(parents=True, exist_ok=True)
header = generated / "dyno_secrets.h"
content = "#pragma once\n" + "\n".join(
    "#define " + key + " " + json.dumps(value)
    for key, value in [("DYNO_OTA_PASSWORD", ota), ("DYNO_SETUP_PASSWORD", setup),
                       ("DYNO_EXTRA_ORIGINS", origins)]
) + "\n"
if not header.exists() or header.read_text() != content:
    header.write_text(content)
env.Append(CPPPATH=[str(generated)])
if env.subst("$UPLOAD_PROTOCOL") == "espota":
    if "upload" in COMMAND_LINE_TARGETS and not ota:
        raise ValueError("OTA requires ota_password in platformio.private.ini or DYNO_OTA_PASSWORD")
    if ota:
        # Quote for the upload shell and escape SCons' own dollar expansion.
        env.Append(UPLOAD_FLAGS=[shlex.quote("--auth=" + ota).replace("$", "$$")])
