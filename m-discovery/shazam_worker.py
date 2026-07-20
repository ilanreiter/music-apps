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
    # identified, so this path isn't exposed to RapidAPI's quota. Confirmed
    # live it also carries a top-level "releasedate" ("07-03-1969", DD-MM-YYYY)
    # and a sections[].metadata "Album" display field (e.g. "Tommy") - same
    # call, no extra cost, so pull both while we're here.
    if key:
        try:
            about = await shazam.track_about(track_id=key)
            if about.get('isrc'):
                data['isrc'] = about['isrc']
            if about.get('releasedate'):
                data['released'] = about['releasedate']
            for section in about.get('sections') or []:
                for meta in section.get('metadata') or []:
                    if meta.get('title') == 'Album' and meta.get('text'):
                        data['album'] = meta['text']
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
