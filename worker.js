const KEY  = 'A8rVZK-wu6MvMu8Chpn7y3ZRSGgu9o07DBgXSfolbsqJQIdc-DfUwzqLOOc1RUyBhCLafFuBFf1WSwwA8WMXTg';
const BASE = 'https://pdp-api.plk-sa.pl/api/v1';

async function plkGet(path) {
  const res = await fetch(BASE + path, { headers: { 'X-API-Key': KEY } });
  if (!res.ok) throw new Error('PLK HTTP ' + res.status);
  return res.json();
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

export default {
  async fetch(request) {
    const url    = new URL(request.url);
    const action = url.searchParams.get('action') || '';

    try {
      if (url.pathname !== '/api') return fetch(request);

      if (action === 'limit') {
        const res = await fetch(BASE + '/data-version', { headers: { 'X-API-Key': KEY } });
        const hourly = res.headers.get('X-RateLimit-Hourly-Remaining') || '?';
        const daily  = res.headers.get('X-RateLimit-Daily-Remaining')  || '?';
        const hourlyLimit = res.headers.get('X-RateLimit-Hourly-Limit') || '?';
        const dailyLimit  = res.headers.get('X-RateLimit-Daily-Limit')  || '?';
        return json({
          hourly_remaining: hourly,
          hourly_limit: hourlyLimit,
          daily_remaining: daily,
          daily_limit: dailyLimit,
        });
      }

      if (action === 'sdip') {
        const stopId = url.searchParams.get('stop') || '';
        if (!stopId) return json({ error: 'Brak stop' }, 400);
        const res = await fetch('https://rj.transportgzm.pl/api/-/sdip/table/' + stopId + '/v2/', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'HX-Request': 'true',
            'HX-Target': 'sdip-time-table-' + stopId,
            'HX-Current-URL': 'https://rj.transportgzm.pl/v2/rozklady/przystanek/stop/' + stopId + '/',
            'Referer': 'https://rj.transportgzm.pl/',
          },
          cf: {
            tlsClientAuth: { enabled: false },
            ssl: { rejectUnauthorized: false },
          }
        });
        if (!res.ok) throw new Error('SDIP HTTP ' + res.status);
        const html = await res.text();
        // Parsuj HTML - wyciągnij wiersze tabeli
        const departures = [];
        // Szukaj wierszy tr z danymi
        const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let rowMatch;
        while ((rowMatch = rowRegex.exec(html)) !== null) {
          const row = rowMatch[1];
          const cells = [];
          const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
          let cellMatch;
          while ((cellMatch = cellRegex.exec(row)) !== null) {
            // Usuń tagi HTML z contentu
            const text = cellMatch[1].replace(/<[^>]+>/g, '').trim();
            if (text) cells.push(text);
          }
          if (cells.length >= 3) {
            departures.push({
              line:      cells[0],
              direction: cells[1],
              minutes:   cells[2]
            });
          }
        }
        // Wyciągnij czas aktualizacji
        const updateMatch = html.match(/Aktualizacja danych:\s*([^<]+)/);
        const updated = updateMatch ? updateMatch[1].trim() : '';
        return json({ stopId, updated, departures });
      }

      if (action === 'delays') {
        const ids   = url.searchParams.get('ids')   || '';
        const names = url.searchParams.get('names') || '';
        if (!ids) return json({ error: 'Brak ids' }, 400);

        const stationIdList = ids.split(',').map(s => s.trim());
        const nameList      = names ? names.split('|') : stationIdList;
        const today         = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
        const trackedParam  = url.searchParams.get('tracked') || '';
        const trackedNums   = trackedParam ? trackedParam.split(',').map(s => s.trim()) : [];

        const [opsData, schedData] = await Promise.all([
          plkGet('/operations?stations=' + ids + '&withPlanned=true&fullRoutes=true&pageSize=500'),
          plkGet('/schedules?stations=' + ids + '&dateFrom=' + today + '&dateTo=' + today + '&pageSize=500')
        ]);

        const trains       = opsData.trains   || [];
        const routes       = schedData.routes || [];
        const stNames      = opsData.stations || {};
        const dict         = schedData.dictionaries || {};
        const stationNames = dict.stations   || {};
        const carrierNames = dict.carriers   || {};
        const catNames     = dict.commercialCategories || {};

        const schedMap = {};
        routes.forEach(r => { schedMap[r.orderId] = r; });

        const result = {};
        stationIdList.forEach((stationId, idx) => {
          const stationName = nameList[idx] || stNames[stationId] || stationId;
          const delayed = [];

          trains.forEach(t => {
            if (t.trainStatus === 'C') return;
            const allStops = t.stations || [];
            const stop = allStops.find(s => String(s.stationId) === String(stationId));
            if (!stop) return;
            const cancelled = t.trainStatus === 'X';
            const delay = Math.max(stop.departureDelayMinutes || 0, stop.arrivalDelayMinutes || 0);
            const r           = schedMap[t.orderId] || {};
            const isTracked = trackedNums.includes(String(r.nationalNumber || ''));
            if (!cancelled && delay <= 0 && !isTracked) return;
            const carrierCode = r.carrierCode || '';
            const catSymbol   = r.commercialCategorySymbol || '';

            const firstStop = allStops[0];
            const lastStop  = allStops[allStops.length - 1];
            const from = firstStop ? (stationNames[firstStop.stationId]?.name || stNames[firstStop.stationId] || '') : '';
            const to   = lastStop  ? (stationNames[lastStop.stationId]?.name  || stNames[lastStop.stationId]  || '') : '';

            delayed.push({
              cancelled, delay,
              trainNumber: r.nationalNumber || t.orderId || '—',
              trainName:   r.name           || '',
              category:    catNames[catSymbol]       || catSymbol,
              catSymbol,
              carrier:     carrierNames[carrierCode] || carrierCode,
              carrierCode, from, to, via: [],
              plannedTime: stop.plannedDeparture || stop.plannedArrival || '',
              actualTime:  stop.actualDeparture  || stop.actualArrival  || '',
            });
          });

          delayed.sort((a, b) => (a.plannedTime.slice(0,5) || '99:99').localeCompare(b.plannedTime.slice(0,5) || '99:99'));
          if (delayed.length > 0) result[stationId] = { name: stationName, trains: delayed };
        });

        return json(result);
      }

      return json({ error: 'Unknown action' }, 400);

    } catch(e) {
      return json({ error: e.message }, 500);
    }
  }
};
