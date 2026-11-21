// Chart Viewer weather relay - a Cloudflare Worker (free plan).
// aviationweather.gov doesn't let web apps on other sites read its data, so this
// tiny relay fetches METAR/TAF there and passes it on with the header browsers need.
// It only forwards METAR and TAF requests for airport codes - nothing else.
//
// Setup: see README.md -> "Weather (METAR / TAF) setup".
//   https://<your-worker>.workers.dev/metar?ids=MPTO,MPMG
//   https://<your-worker>.workers.dev/taf?ids=MPTO

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const kind = url.pathname.replace(/^\/+|\/+$/g, '');
    if (kind !== 'metar' && kind !== 'taf') {
      return new Response('Chart Viewer weather relay: use /metar?ids=XXXX or /taf?ids=XXXX', { status: 404, headers: cors });
    }
    const ids = (url.searchParams.get('ids') || '').toUpperCase().replace(/[^A-Z0-9,]/g, '').slice(0, 120);
    if (!ids) return new Response('[]', { status: 400, headers: { ...cors, 'content-type': 'application/json' } });
    const upstream = `https://aviationweather.gov/api/data/${kind}?ids=${ids}&format=json${kind === 'taf' ? '' : '&hours=3'}`;
    const r = await fetch(upstream, {
      headers: { 'User-Agent': 'chartviewer-weather-relay' },
      cf: { cacheTtl: 120, cacheEverything: true },
    });
    const body = r.status === 204 ? '[]' : await r.text();
    return new Response(body || '[]', {
      status: r.ok || r.status === 204 ? 200 : r.status,
      headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'max-age=120' },
    });
  },
};
