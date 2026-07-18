import asyncio
import json
import sys

from shazamio import Shazam


async def _recognize(file_path):
    shazam = Shazam()
    result = await shazam.recognize(file_path)
    track = result.get('track') or {}
    return {'title': track.get('title'), 'artist': track.get('subtitle')}


def main():
    try:
        data = asyncio.run(_recognize(sys.argv[1]))
    except Exception:
        data = {}
    print(json.dumps(data))


if __name__ == '__main__':
    main()
