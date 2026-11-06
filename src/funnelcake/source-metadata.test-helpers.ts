// ABOUTME: Mirrors current mobile and web video metadata using synthetic media values.
// ABOUTME: Shares writer compatibility fixtures across publishing route and service tests.
const HASH = '1111111111111111111111111111111111111111111111111111111111111111'
export const SOURCE_METADATA_CASES = [
  {
    name: 'mobile single URL with measured event duration',
    tags: [['imeta', 'url https://media.divine.video/streaming.mp4', 'm video/mp4', 'image https://media.divine.video/thumbnail.jpg', 'dim 1080x1920', 'x ' + HASH, 'size 240000'], ['duration', '6']],
    url: 'https://media.divine.video/streaming.mp4', hash: HASH,
  },
  {
    name: 'mobile streaming, fallback and HLS URLs in one descriptor',
    tags: [['imeta', 'url https://media.divine.video/streaming.mp4', 'url https://cdn.divine.video/fallback.mp4', 'url https://media.divine.video/streaming.m3u8', 'm video/mp4', 'image https://media.divine.video/thumbnail.jpg', 'dim 1080x1920', 'x ' + HASH, 'size 240000'], ['duration', '6']],
    url: 'https://media.divine.video/streaming.mp4', hash: HASH,
  },
  {
    name: 'mobile first usable URL after an unsupported media host',
    tags: [['imeta', 'url https://example.com/streaming.mp4', 'url https://cdn.divine.video/fallback.mp4', 'url https://media.divine.video/streaming.m3u8', 'm video/mp4', 'x ' + HASH], ['duration', '6']],
    url: 'https://cdn.divine.video/fallback.mp4', hash: HASH,
  },
  {
    name: 'web alternating fields with descriptor duration',
    tags: [['imeta', 'url', 'https://media.divine.video/web.mp4', 'm', 'video/mp4', 'dim', '1080x1920', 'image', 'https://media.divine.video/thumbnail.jpg', 'duration', '6', 'size', '240000', 'x', HASH]],
    url: 'https://media.divine.video/web.mp4', hash: HASH,
  },
]
