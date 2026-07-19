import sys
from pathlib import Path


def init_config():
    root_path = Path(
        "/Users/jethroestrada/Desktop/External_Projects/Jet_Apps/web-extensions/smart-web-extensions/missav-extension/server"
    )
    sys.path.append(str(root_path))
