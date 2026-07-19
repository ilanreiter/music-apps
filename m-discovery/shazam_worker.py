import asyncio
import json
import sys

from shazamio import Shazam


async def _recognize(file_path):
    shazam = Shazam()
    result = await shazam.recognize(file_path)
    track = result.get('track') or {}
    title, artist, key = track.get('title'), track.get('subtitle'), track.get('key')
    if not title or not artist:
        return {}
    data = {'title': title, 'artist': artist}
    # track_about is a second call to Shazam's own servers (same as
    # recognize, no RapidAPI involved) that includes an ISRC directly as a
    # top-level field - getting it here means the caller never needs
    # Shazam Core/RapidAPI at all for a track audio recognition already
    # identified, so this path isn't exposed to RapidAPI's quota.
    if key:
        try:
            about = await shazam.track_about(track_id=key)
            if about.get('isrc'):
                data['isrc'] = about['isrc']
        except Exception:
            pass
    return data


def main():
    try:
        data = asyncio.run(_recognize(sys.argv[1]))
    except Exception:
        data = {}
    print(json.dumps(data))


if __name__ == '__main__':
    main()
