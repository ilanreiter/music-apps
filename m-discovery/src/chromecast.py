import logging
import os
import re
import threading

import pychromecast

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 8

# device_id -> connected pychromecast.Chromecast, reused across calls. Unlike
# WiiM's stateless HTTP+SOAP requests, pychromecast maintains a persistent
# socket + background receiver thread per device, so reconnecting on every
# command would redo a multi-second discovery/handshake each time.
_cast_cache = {}
_cast_lock = threading.Lock()


def _slug(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-') or 'device'


def _load_devices():
    # Same "Name:ip,Name2:ip2" format as WIIM_DEVICES - and for the same
    # reason: connecting to a known IP directly sidesteps relying on mDNS
    # multicast reaching the container, which is unreliable in Docker.
    raw = os.environ.get('CHROMECAST_DEVICES', '')
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


def _invalidate(device_id):
    with _cast_lock:
        cast = _cast_cache.pop(device_id, None)
    if cast is not None:
        try:
            cast.disconnect(blocking=False)
        except Exception:
            pass


def _get_cast(device_id):
    """Returns a connected Chromecast instance for this device, reusing a
    cached connection when available. Returns None if the device is unknown
    or unreachable."""
    with _cast_lock:
        cast = _cast_cache.get(device_id)
    if cast is not None:
        return cast

    device = DEVICES.get(device_id)
    if not device:
        return None
    try:
        chromecasts, browser = pychromecast.get_chromecasts(
            known_hosts=[device['ip']], timeout=REQUEST_TIMEOUT,
        )
        matches = [cc for cc in chromecasts if cc.cast_info.host == device['ip']]
        if not matches:
            return None
        cast = matches[0]
        cast.wait(timeout=REQUEST_TIMEOUT)
        with _cast_lock:
            _cast_cache[device_id] = cast
        return cast
    except Exception:
        return None


def _build_media_info(item):
    metadata = {
        'metadataType': 3,  # MetadataType.MUSIC_TRACK
        'title': item.get('title'),
        'artist': item.get('artist'),
        'albumName': item.get('album'),
    }
    art_url = item.get('art_url')
    if art_url:
        metadata['thumb'] = art_url
        metadata['images'] = [{'url': art_url}]
    return {
        'contentId': item['stream_url'],
        'streamType': 'BUFFERED',
        'contentType': item['content_type'],
        'metadata': metadata,
    }


def play_queue(device_id, items):
    """Loads the whole queue as one QUEUE_LOAD message, so the device's own
    next/prev - including the TV remote's skip buttons and the receiver's
    on-screen queue UI - work natively.

    pychromecast's high-level play_media() only exposes LOAD (single item)
    and QUEUE_INSERT (append one item to an already-running session) - not
    QUEUE_LOAD. Empirically, LOAD+QUEUE_INSERT does let *our own* app issue
    queue-next/queue-prev successfully (the underlying queue data is there),
    but the TV's on-screen buttons and remote never turn on - apparently
    because the receiver only decides "this is a real queue" from the
    original load message, and ours only ever described one track. QUEUE_LOAD
    describes the whole queue up front instead, which is what a genuine
    Cast sender app would send."""
    cast = _get_cast(device_id)
    if cast is None or not items:
        return False
    try:
        mc = cast.media_controller
        queue_items = [
            {'media': _build_media_info(item), 'autoplay': True, 'startTime': 0, 'preloadTime': 0}
            for item in items
        ]
        mc.send_message({
            'type': 'QUEUE_LOAD',
            'items': queue_items,
            'startIndex': 0,
            'repeatMode': 'REPEAT_OFF',
        }, inc_session_id=True)
        logger.info("Chromecast %s: QUEUE_LOAD sent, %d item(s)", device_id, len(items))
        return True
    except Exception:
        logger.exception("Chromecast %s: play_queue (QUEUE_LOAD) failed", device_id)
        _invalidate(device_id)
        return False


def queue_insert(device_id, items):
    """Appends items to the end of the device's already-loaded native queue via
    a raw QUEUE_INSERT cast message - unlike play_queue's QUEUE_LOAD, this does
    NOT interrupt/restart what's currently playing. Used by playback_advancer
    to keep the native queue topped up past CHROMECAST_QUEUE_WINDOW tracks
    without a full reload."""
    cast = _get_cast(device_id)
    if cast is None or not items:
        return False
    try:
        mc = cast.media_controller
        queue_items = [
            {'media': _build_media_info(item), 'autoplay': True, 'startTime': 0, 'preloadTime': 0}
            for item in items
        ]
        mc.send_message({
            'type': 'QUEUE_INSERT',
            'items': queue_items,
        }, inc_session_id=True)
        logger.info("Chromecast %s: QUEUE_INSERT sent, %d item(s)", device_id, len(items))
        return True
    except Exception:
        logger.exception("Chromecast %s: queue_insert (QUEUE_INSERT) failed", device_id)
        _invalidate(device_id)
        return False


def queue_next(device_id):
    cast = _get_cast(device_id)
    if cast is None:
        return False
    try:
        logger.info("Chromecast %s: queue_next (current content_id=%r)", device_id, cast.media_controller.status.content_id)
        cast.media_controller.queue_next()
        return True
    except Exception:
        logger.exception("Chromecast %s: queue_next failed", device_id)
        _invalidate(device_id)
        return False


def queue_prev(device_id):
    cast = _get_cast(device_id)
    if cast is None:
        return False
    try:
        logger.info("Chromecast %s: queue_prev (current content_id=%r)", device_id, cast.media_controller.status.content_id)
        cast.media_controller.queue_prev()
        return True
    except Exception:
        logger.exception("Chromecast %s: queue_prev failed", device_id)
        _invalidate(device_id)
        return False


def pause(device_id):
    cast = _get_cast(device_id)
    if cast is None:
        return False
    try:
        cast.media_controller.pause()
        return True
    except Exception:
        _invalidate(device_id)
        return False


def resume(device_id):
    cast = _get_cast(device_id)
    if cast is None:
        return False
    try:
        cast.media_controller.play()
        return True
    except Exception:
        _invalidate(device_id)
        return False


def stop(device_id):
    cast = _get_cast(device_id)
    if cast is None:
        return False
    try:
        cast.media_controller.stop()
        return True
    except Exception:
        _invalidate(device_id)
        return False


def seek(device_id, position_ms):
    cast = _get_cast(device_id)
    if cast is None:
        return False
    try:
        cast.media_controller.seek(position_ms / 1000)
        return True
    except Exception:
        _invalidate(device_id)
        return False


def set_volume(device_id, level):
    cast = _get_cast(device_id)
    if cast is None:
        return False
    try:
        cast.set_volume(max(0, min(100, int(level))) / 100)
        return True
    except Exception:
        _invalidate(device_id)
        return False


def get_status(device_id):
    """Returns playback status/position from the device, or None if unreachable."""
    cast = _get_cast(device_id)
    if cast is None:
        return None
    try:
        mc = cast.media_controller
        media_status = mc.status
        player_state = media_status.player_state
        if player_state == 'PLAYING':
            play_state = 'play'
        elif player_state == 'PAUSED':
            play_state = 'pause'
        else:
            play_state = 'stop'

        volume = None
        if cast.status:
            volume = round((cast.status.volume_level or 0) * 100)

        return {
            'status': play_state,
            'position_ms': int((media_status.adjusted_current_time or 0) * 1000),
            'duration_ms': int((media_status.duration or 0) * 1000),
            'volume': volume,
            # Lets the frontend detect when the TV's own remote (not our UI)
            # skipped to a different queue item, by diffing against the track
            # id embedded in our stream URL.
            'content_id': media_status.content_id,
        }
    except Exception:
        _invalidate(device_id)
        return None
