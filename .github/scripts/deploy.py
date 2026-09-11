"""Send an immutable image manifest to the application's restricted SSH endpoint."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

app = os.environ['DEPLOY_APP']
images = json.loads(os.environ['DEPLOY_IMAGES'])
payload = {'action': 'deploy', 'revision': os.environ['GITHUB_SHA'], 'images': images,
           'registry_user': os.environ['GITHUB_ACTOR'], 'registry_token': os.environ['GHCR_TOKEN']}
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    key, known = root / 'key', root / 'known_hosts'
    key.write_text(os.environ['VPS_SSH_KEY'] + '\n')
    key.chmod(0o600)
    known.write_text(os.environ['VPS_KNOWN_HOSTS'] + '\n')
    subprocess.run(['ssh', '-F', '/dev/null', '-i', str(key), '-o', 'IdentitiesOnly=yes',
                    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                    '-o', 'UserKnownHostsFile=' + str(known), '-o', 'ConnectTimeout=15',
                    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
                    'deploy-' + app + '@guillaumevdn.com', 'deploy'],
                   input=json.dumps(payload).encode(), check=True, timeout=1500)
