import os
import re
from xml.sax.saxutils import escape

import requests

REQUEST_TIMEOUT = 6
UPNP_PORT = 49152  # confirmed against real WiiM Mini + WiiM Ultra hardware

AVTRANSPORT_SERVICE = "urn:schemas-upnp-org:service:AVTransport:1"
RENDERINGCONTROL_SERVICE = "urn:schemas-upnp-org:service:RenderingControl:1"

# ip -> {'avtransport': control_url, 'renderingcontrol': control_url}, cached
# after first discovery since these don't change for a running device.
_service_cache = {}


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


def _discover_services(ip):
    """Fetch and cache a device's UPnP AVTransport/RenderingControl control URLs
    from its description XML. Returns None if the device is unreachable."""
    if ip in _service_cache:
        return _service_cache[ip]
    try:
        response = requests.get(f"http://{ip}:{UPNP_PORT}/description.xml", timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        text = response.text
    except Exception:
        return None

    services = dict(re.findall(r'<serviceType>(.*?)</serviceType>.*?<controlURL>(.*?)</controlURL>', text, re.DOTALL))
    result = {
        'avtransport': services.get(AVTRANSPORT_SERVICE),
        'renderingcontrol': services.get(RENDERINGCONTROL_SERVICE),
    }
    _service_cache[ip] = result
    return result


def _soap_request(ip, control_url, service_type, action, args):
    args_xml = ''.join(f"<{key}>{value}</{key}>" for key, value in args.items())
    body = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" '
        'xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>'
        f'<u:{action} xmlns:u="{service_type}">{args_xml}</u:{action}>'
        '</s:Body></s:Envelope>'
    )
    try:
        response = requests.post(
            f"http://{ip}:{UPNP_PORT}{control_url}",
            data=body.encode('utf-8'),
            headers={
                'Content-Type': 'text/xml; charset="utf-8"',
                'SOAPAction': f'"{service_type}#{action}"',
            },
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        return response.text
    except Exception:
        return None


def _build_didl(track_id, title, artist, album, stream_url, art_url):
    # Built as a standalone DIDL-Lite document, then escaped once more so it can
    # be embedded as the text content of the outer SOAP request's
    # <CurrentURIMetaData> element (XML-in-XML always needs this double escape).
    item = (
        '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" '
        'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">'
        f'<item id="{track_id}" parentID="0" restricted="1">'
        f'<dc:title>{escape(title or "")}</dc:title>'
        f'<upnp:artist>{escape(artist or "")}</upnp:artist>'
        f'<upnp:album>{escape(album or "")}</upnp:album>'
        f'<upnp:albumArtURI>{escape(art_url)}</upnp:albumArtURI>'
        f'<res protocolInfo="http-get:*:audio/mpeg:*">{escape(stream_url)}</res>'
        '<upnp:class>object.item.audioItem.musicTrack</upnp:class>'
        '</item></DIDL-Lite>'
    )
    return escape(item)


def play_url(ip, track_id, stream_url, art_url, title=None, artist=None, album=None):
    services = _discover_services(ip)
    if not services or not services.get('avtransport'):
        return False
    control_url = services['avtransport']

    metadata = _build_didl(track_id, title, artist, album, stream_url, art_url)
    set_uri_ok = _soap_request(ip, control_url, AVTRANSPORT_SERVICE, 'SetAVTransportURI', {
        'InstanceID': 0,
        'CurrentURI': escape(stream_url),
        'CurrentURIMetaData': metadata,
    })
    if set_uri_ok is None:
        return False
    return _soap_request(ip, control_url, AVTRANSPORT_SERVICE, 'Play', {'InstanceID': 0, 'Speed': 1}) is not None


def pause(ip):
    services = _discover_services(ip)
    if not services or not services.get('avtransport'):
        return False
    return _soap_request(ip, services['avtransport'], AVTRANSPORT_SERVICE, 'Pause', {'InstanceID': 0}) is not None


def resume(ip):
    services = _discover_services(ip)
    if not services or not services.get('avtransport'):
        return False
    return _soap_request(ip, services['avtransport'], AVTRANSPORT_SERVICE, 'Play', {'InstanceID': 0, 'Speed': 1}) is not None


def stop(ip):
    services = _discover_services(ip)
    if not services or not services.get('avtransport'):
        return False
    return _soap_request(ip, services['avtransport'], AVTRANSPORT_SERVICE, 'Stop', {'InstanceID': 0}) is not None


def _ms_to_time_str(position_ms):
    total_seconds = max(0, int(position_ms) // 1000)
    h, rem = divmod(total_seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def seek(ip, position_ms):
    services = _discover_services(ip)
    if not services or not services.get('avtransport'):
        return False
    return _soap_request(ip, services['avtransport'], AVTRANSPORT_SERVICE, 'Seek', {
        'InstanceID': 0, 'Unit': 'REL_TIME', 'Target': _ms_to_time_str(position_ms),
    }) is not None


def set_volume(ip, level):
    services = _discover_services(ip)
    if not services or not services.get('renderingcontrol'):
        return False
    level = max(0, min(100, int(level)))
    return _soap_request(ip, services['renderingcontrol'], RENDERINGCONTROL_SERVICE, 'SetVolume', {
        'InstanceID': 0, 'Channel': 'Master', 'DesiredVolume': level,
    }) is not None


def _parse_time_to_ms(time_str):
    if not time_str:
        return 0
    try:
        h, m, s = (int(p) for p in time_str.split(':')[-3:])
        return (h * 3600 + m * 60 + s) * 1000
    except ValueError:
        return 0


def get_status(ip):
    """Returns playback status/position from the device, or None if unreachable."""
    services = _discover_services(ip)
    if not services or not services.get('avtransport'):
        return None

    transport_info = _soap_request(ip, services['avtransport'], AVTRANSPORT_SERVICE, 'GetTransportInfo', {'InstanceID': 0})
    position_info = _soap_request(ip, services['avtransport'], AVTRANSPORT_SERVICE, 'GetPositionInfo', {'InstanceID': 0})
    if transport_info is None or position_info is None:
        return None

    state_match = re.search(r'<CurrentTransportState>(.*?)</CurrentTransportState>', transport_info)
    # Exact match, not substring: "PAUSED_PLAYBACK" contains "PLAY" as a substring
    # (from "PLAYBACK"), which would misclassify paused as playing.
    state = state_match.group(1) if state_match else ''
    if state == 'PLAYING':
        play_state = 'play'
    elif state == 'PAUSED_PLAYBACK':
        play_state = 'pause'
    else:
        play_state = 'stop'

    rel_time_match = re.search(r'<RelTime>(.*?)</RelTime>', position_info)
    duration_match = re.search(r'<TrackDuration>(.*?)</TrackDuration>', position_info)

    volume = None
    if services.get('renderingcontrol'):
        vol_response = _soap_request(ip, services['renderingcontrol'], RENDERINGCONTROL_SERVICE, 'GetVolume', {
            'InstanceID': 0, 'Channel': 'Master',
        })
        vol_match = re.search(r'<CurrentVolume>(.*?)</CurrentVolume>', vol_response) if vol_response else None
        volume = int(vol_match.group(1)) if vol_match else None

    return {
        'status': play_state,
        'position_ms': _parse_time_to_ms(rel_time_match.group(1) if rel_time_match else None),
        'duration_ms': _parse_time_to_ms(duration_match.group(1) if duration_match else None),
        'volume': volume,
    }
