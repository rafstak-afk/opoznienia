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
        const today         = new Date().toISOString().slice(0, 10);

        const [opsData, schedData] = await Promise.all([
          plkGet('/operations?stations=' + ids + '&withPlanned=true&fullRoutes=true&pageSize=500&operatingDate=' + today),
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
            if (!cancelled && delay <= 0) return;

            const r           = schedMap[t.orderId] || {};
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
