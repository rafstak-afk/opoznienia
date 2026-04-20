const KEY  = 'A8rVZK-wu6MvMu8Chpn7y3ZRSGgu9o07DBgXSfolbsqJQIdc-DfUwzqLOOc1RUyBhCLafFuBFf1WSwwA8WMXTg';
const BASE = 'https://pdp-api.plk-sa.pl/api/v1';

async function plkGet(path) {
  const res = await fetch(BASE + path, { headers: { 'X-API-Key': KEY } });
  if (!res.ok) throw new Error('PLK HTTP ' + res.status);
  return res.json();
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

export default {
  async fetch(request) {
    const url    = new URL(request.url);
    const action = url.searchParams.get('action') || '';

    try {

      // Serwuj index.html dla głównej strony
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return fetch(request);
      }

      // API endpoint
      if (url.pathname === '/api') {

        if (action === 'search') {
          const q = url.searchParams.get('q') || '';
          const data = await plkGet('/dictionaries/stations?search=' + encodeURIComponent(q) + '&pageSize=8');
          return json(data);
        }

        if (action === 'route') {
          const ids   = url.searchParams.get('ids') || '';
          const num   = url.searchParams.get('num') || '';
          const today = new Date().toISOString().slice(0, 10);
          const sched = await plkGet('/schedules?stations=' + ids + '&dateFrom=' + today + '&dateTo=' + today + '&pageSize=500');
          const found = (sched.routes || []).find(r => r.nationalNumber === num);
          if (!found) return json({ error: 'Nie znaleziono' }, 404);
          const route = await plkGet('/schedules/route/' + found.scheduleId + '/' + found.orderId);
          return json({ train: found, route, dict: sched.dictionaries });
        }

        if (action === 'delays') {
          const ids   = url.searchParams.get('ids')   || '';
          const names = url.searchParams.get('names') || '';
          if (!ids) return json({ error: 'Brak ids' }, 400);

          const stationIdList = ids.split(',').map(s => s.trim());
          const nameList      = names ? names.split('|') : stationIdList;
          const today         = new Date().toISOString().slice(0, 10);

          const [opsData, schedData] = await Promise.all([
            plkGet('/operations?stations=' + ids + '&withPlanned=true&pageSize=500'),
            plkGet('/schedules?stations=' + ids + '&dateFrom=' + today + '&dateTo=' + today + '&pageSize=500')
          ]);

          const trains  = opsData.trains  || [];
          const routes  = schedData.routes || [];
          const stNames = opsData.stations || {};

          const dict         = schedData.dictionaries || {};
          const stationNames = dict.stations   || {};
          const carrierNames = dict.carriers   || {};
          const catNames     = dict.commercialCategories || {};

          const schedMap = {};
          routes.forEach(r => { schedMap[r.orderId] = r; });

          // Zbierz unikalne opóźnione pociągi
          const delayedSet = new Map();
          trains.forEach(t => {
            if (t.trainStatus === 'C') return;
            stationIdList.forEach(stationId => {
              const stop = (t.stations || []).find(s => String(s.stationId) === String(stationId));
              if (!stop) return;
              const cancelled = t.trainStatus === 'X';
              const delay = Math.max(stop.departureDelayMinutes || 0, stop.arrivalDelayMinutes || 0);
              if (!cancelled && delay <= 0) return;
              if (!delayedSet.has(t.orderId)) delayedSet.set(t.orderId, t);
            });
          });

          // Pobierz pełne trasy równolegle (max 15)
          const routeMap = {};
          const toFetch = [...delayedSet.values()].slice(0, 15);
          await Promise.all(toFetch.map(async t => {
            try {
              const data = await plkGet('/schedules/route/' + t.scheduleId + '/' + t.orderId);
              routeMap[t.orderId] = data;
            } catch(e) {}
          }));

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

              const r           = schedMap[t.orderId] || {};
              const carrierCode = r.carrierCode || '';
              const catSymbol   = r.commercialCategorySymbol || '';

              // Relacja z pełnej trasy
              const fullRoute = routeMap[t.orderId];
              const fullStops = fullRoute?.stations || [];
              const routeDict = fullRoute?.dictionaries?.stations || {};
              let from = '', to = '';
              if (fullStops.length > 0) {
                const firstId = fullStops[0]?.stationId;
                const lastId  = fullStops[fullStops.length - 1]?.stationId;
                from = firstId ? (routeDict[firstId]?.name || stationNames[firstId]?.name || '') : '';
                to   = lastId  ? (routeDict[lastId]?.name  || stationNames[lastId]?.name  || '') : '';
              }

              delayed.push({
                cancelled,
                delay,
                trainNumber: r.nationalNumber || t.orderId || '—',
                trainName:   r.name           || '',
                category:    catNames[catSymbol]       || catSymbol,
                catSymbol,
                carrier:     carrierNames[carrierCode] || carrierCode,
                carrierCode,
                from,
                to,
                via: [],
                plannedTime: stop.plannedDeparture || stop.plannedArrival || '',
                actualTime:  stop.actualDeparture  || stop.actualArrival  || '',
              });
            });

            delayed.sort((a, b) => {
              const ta = a.plannedTime.slice(0, 5) || '99:99';
              const tb = b.plannedTime.slice(0, 5) || '99:99';
              return ta.localeCompare(tb);
            });

            if (delayed.length > 0) {
              result[stationId] = { name: stationName, trains: delayed };
            }
          });

          return json(result);
        }

        return json({ error: 'Unknown action' }, 400);
      }

      // Dla wszystkich innych ścieżek serwuj pliki statyczne
      return fetch(request);

    } catch(e) {
      return json({ error: e.message }, 500);
    }
  }
};
