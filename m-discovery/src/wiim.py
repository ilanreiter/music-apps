import json
import os
import re

import requests
import urllib3
from urllib3.exceptions import InsecureRequestWarning

# WiiM/LinkPlay devices serve their control API over HTTPS with a self-signed
# cert (confirmed against real hardware - plain HTTP doesn't respond on current
# firmware), so verify=False is required and the resulting warning is expected.
urllib3.disable_warnings(InsecureRequestWarning)

REQUEST_TIMEOUT = 6


def _slug(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-') or 'device'


def _load_devices():
    # Format: "Name:ip,Name2:ip2" - simple enough to hand-edit in .env.
    raw = os.environ.get('WIIM_DEVICES', '')
    devices = {}
    for entry in raw.split(','):
        entry = entry.strip()
        if not entry or ':' not in entry:
            continue
        name, ip = entry.rsplit(':', 1)
        name, ip = name.strip(), ip.strip()
        if not name or not ip:
            continue
        device_id = _slug(name)
        devices[device_id] = {'id': device_id, 'name': name, 'ip': ip}
    return devices


DEVICES = _load_devices()


def list_devices():
    return list(DEVICES.values())


def get_device(device_id):
    return DEVICES.get(device_id)


def _command(ip, command):
    """Send a LinkPlay HTTP API command. Returns the raw response text, or None
    on any network/HTTP failure (device offline, wrong IP, etc.)."""
    try:
        response = requests.get(
            f"https://{ip}/httpapi.asp?command={command}",
            timeout=REQUEST_TIMEOUT, verify=False,
        )
        response.raise_for_status()
        return response.text
    except Exception:
        return None


def _hex_decode(value):
    if not value:
        return None
    try:
        return bytes.fromhex(value).decode('utf-8', errors='replace')
    except ValueError:
        return value


def play_url(ip, url):
    return _command(ip, f"setPlayerCmd:play:{url}") == 'OK'


def pause(ip):
    return _command(ip, "setPlayerCmd:pause") == 'OK'


def resume(ip):
    return _command(ip, "setPlayerCmd:resume") == 'OK'


def stop(ip):
    return _command(ip, "setPlayerCmd:stop") == 'OK'


def set_volume(ip, level):
    level = max(0, min(100, int(level)))
    return _command(ip, f"setPlayerCmd:vol:{level}") == 'OK'


def get_status(ip):
    """Returns playback status/position from the device, or None if unreachable.

    Title/Artist/Album are only meaningful when the device is playing something
    from its own source (radio, Spotify Connect, etc.) - when we push a raw
    stream URL via play_url, the device doesn't parse embedded ID3 tags, so
    these come back as the URL itself or blank. The frontend already knows the
    real track metadata from its own queue; this is mainly for position/duration
    (to detect end-of-track) and play/pause state.
    """
    raw = _command(ip, "getPlayerStatus")
    if raw is None:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return {
        'status': data.get('status'),
        'title': _hex_decode(data.get('Title')),
        'artist': _hex_decode(data.get('Artist')),
        'album': _hex_decode(data.get('Album')),
        'position_ms': int(data.get('curpos', 0) or 0),
        'duration_ms': int(data.get('totlen', 0) or 0),
        'volume': int(data.get('vol', 0) or 0),
    }
