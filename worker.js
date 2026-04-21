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

      if (action === 'delays') {
        const ids   = url.searchParams.get('ids')   || '';
        const names = url.searchParams.get('names') || '';
        if (!ids) return json({ error: 'Brak ids' }, 400);

        const stationIdList = ids.split(',').map(s => s.trim());
        const nameList      = names ? names.split('|') : stationIdList;

        // Jedno zapytanie z fullRoutes=true — zawiera pełne trasy i opóźnienia
        const opsData = await plkGet(
          '/operations?stations=' + ids +
          '&withPlanned=true&fullRoutes=true&pageSize=500'
        );

        const trains       = opsData.trains  || [];
        const stNames      = opsData.stations || {};

        const result = {};
        stationIdList.forEach((stationId, idx) => {
          const stationName = nameList[idx] || stNames[stationId] || stationId;
          const delayed = [];

          trains.forEach(t => {
            if (t.trainStatus === 'C') return;
            const stop = (t.stations || []).find(s => String(s.stationId) === String(stationId));
            if (!stop) return;
            const cancelled = t.trainStatus === 'X';
            const delay = Math.max(stop.departureDelayMinutes || 0, stop.arrivalDelayMinutes || 0);
            if (!cancelled && delay <= 0) return;

            // Pełna trasa z fullRoutes=true
            const allStops = t.stations || [];
            const firstStop = allStops[0];
            const lastStop  = allStops[allStops.length - 1];
            const from = firstStop ? (stNames[firstStop.stationId] || '') : '';
            const to   = lastStop  ? (stNames[lastStop.stationId]  || '') : '';

            delayed.push({
              cancelled, delay,
              trainNumber: t.trainNumber || t.orderId || '—',
              trainName:   t.trainName   || '',
              category:    t.commercialCategoryName || t.commercialCategorySymbol || '',
              catSymbol:   t.commercialCategorySymbol || '',
              carrier:     t.carrierName || t.carrierCode || '',
              carrierCode: t.carrierCode || '',
              from, to, via: [],
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
