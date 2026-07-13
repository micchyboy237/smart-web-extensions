import sys
from pathlib import Path


def init_config():
    # Add the server/services directory to Python's module search path
    services_path = Path(
        "/Users/jethroestrada/Desktop/External_Projects/Jet_Apps/web-extensions/smart-web-extensions/missav-extension/server/services"
    )
    sys.path.append(str(services_path))
