const https = require('https');

const KEY = 'A8rVZK-wu6MvMu8Chpn7y3ZRSGgu9o07DBgXSfolbsqJQIdc-DfUwzqLOOc1RUyBhCLafFuBFf1WSwwA8WMXTg';
const BASE = 'pdp-api.plk-sa.pl';

function plkGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE,
      path: '/api/v1' + path,
      method: 'GET',
      headers: { 'X-API-Key': KEY }
    };
    https.get(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Błąd parsowania: ' + data.slice(0, 100))); }
      });
    }).on('error', reject);
  });
}

// Czy czas odjazdu/przyjazdu ze stacji jest nie starszy niż 10 minut
function isRecent(stop) {
  const timeStr = stop.actualDeparture || stop.plannedDeparture
                || stop.actualArrival  || stop.plannedArrival;
  if (!timeStr) return true;
  try {
    let d;
    if (/^\d{2}:\d{2}/.test(timeStr)) {
      // Format HH:MM:SS — dołącz dzisiejszą datę
      const today = new Date().toISOString().slice(0, 10);
      d = new Date(today + 'T' + timeStr);
    } else {
      d = new Date(timeStr);
    }
    if (isNaN(d)) return true;
    const diffMin = (Date.now() - d.getTime()) / 60000;
    return diffMin < 10;
  } catch { return true; }
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  const action = event.queryStringParameters?.action || 'delays';

  try {

    if (action === 'search') {
      const q = event.queryStringParameters?.q || '';
      const data = await plkGet('/dictionaries/stations?search=' + encodeURIComponent(q) + '&pageSize=8');
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    if (action === 'delays') {
      const ids   = event.queryStringParameters?.ids   || '';
      const names = event.queryStringParameters?.names || '';
      if (!ids) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Brak ids' }) };

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

      const result = {};
      stationIdList.forEach((stationId, idx) => {
        const stationName = nameList[idx] || stNames[stationId] || stationId;
        const delayed = [];

        trains.forEach(t => {
          // Krok 1: pomiń zakończone (C) i wszystkie inne niż aktywne/odwołane
          if (t.trainStatus === 'C') return;

          const stops = t.stations || [];
          const stop  = stops.find(s => String(s.stationId) === String(stationId));
          if (!stop) return;

          // Krok 2: pomiń jeśli odjazd z tej stacji był ponad 10 minut temu
          if (!isRecent(stop)) return;

          const cancelled = t.trainStatus === 'X';
          const delay     = Math.max(stop.departureDelayMinutes || 0, stop.arrivalDelayMinutes || 0);
          if (!cancelled && delay <= 0) return;

          const r = schedMap[t.orderId] || {};
          const routeStops  = r.stations || [];
          const firstStopId = routeStops[0]?.stationId;
          const lastStopId  = routeStops[routeStops.length - 1]?.stationId;
          const from = firstStopId ? (stationNames[firstStopId]?.name || '') : '';
          const to   = lastStopId  ? (stationNames[lastStopId]?.name  || '') : '';
          const via  = routeStops
            .slice(1, -1)
            .map(s => stationNames[s.stationId]?.name || '')
            .filter(Boolean);

          const carrierCode = r.carrierCode || '';
          const catSymbol   = r.commercialCategorySymbol || '';
          const carrier     = carrierNames[carrierCode] || carrierCode;
          const category    = catNames[catSymbol]       || catSymbol;

          delayed.push({
            cancelled,
            delay,
            trainNumber: r.nationalNumber  || t.orderId || '—',
            trainName:   r.name            || '',
            category,
            catSymbol,
            carrier,
            carrierCode,
            from,
            to,
            via,
            plannedTime: stop.plannedDeparture || stop.plannedArrival || '',
            actualTime:  stop.actualDeparture  || stop.actualArrival  || '',
          });
        });

        delayed.sort((a, b) => {
          if (a.cancelled !== b.cancelled) return a.cancelled ? -1 : 1;
          return b.delay - a.delay;
        });

        if (delayed.length > 0) {
          result[stationId] = { name: stationName, trains: delayed };
        }
      });

      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
