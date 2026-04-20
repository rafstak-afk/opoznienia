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

function parseStopTime(timeStr) {
  if (!timeStr) return null;
  try {
    if (/^\d{2}:\d{2}/.test(timeStr)) {
      const now = new Date();
      const todayStr = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
      const warsawNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
      const utcNow    = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
      const offsetMs  = utcNow - warsawNow;
      const local     = new Date(todayStr + 'T' + timeStr);
      return new Date(local.getTime() + offsetMs);
    } else {
      return new Date(timeStr);
    }
  } catch { return null; }
}

function isRecent(stop) {
  const timeStr = stop.actualDeparture || stop.plannedDeparture
                || stop.actualArrival  || stop.plannedArrival;
  const d = parseStopTime(timeStr);
  if (!d || isNaN(d)) return true;
  const diffMin = (Date.now() - d.getTime()) / 60000;
  return diffMin < 10;
}

function timeToMinutes(timeStr) {
  const d = parseStopTime(timeStr);
  if (!d || isNaN(d)) return 9999;
  return d.getHours() * 60 + d.getMinutes();
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

      // Znajdź opóźnione pociągi które przejdą filtry
      const delayedTrains = [];
      trains.forEach(t => {
        if (t.trainStatus === 'C') return;
        stationIdList.forEach(stationId => {
          const stops = t.stations || [];
          const stop  = stops.find(s => String(s.stationId) === String(stationId));
          if (!stop) return;
          if (!isRecent(stop)) return;
          const cancelled = t.trainStatus === 'X';
          const delay     = Math.max(stop.departureDelayMinutes || 0, stop.arrivalDelayMinutes || 0);
          if (!cancelled && delay <= 0) return;
          // Sprawdź czy już mamy ten pociąg
          if (!delayedTrains.find(x => x.orderId === t.orderId)) {
            delayedTrains.push(t);
          }
        });
      });

      // Pobierz pełne trasy dla opóźnionych pociągów (równolegle, max 20)
      const routeMap = {};
      const toFetch  = delayedTrains.slice(0, 20);
      await Promise.all(toFetch.map(async t => {
        try {
          const data = await plkGet('/schedules/route/' + t.scheduleId + '/' + t.orderId);
          routeMap[t.orderId] = data;
        } catch(e) {}
      }));

      // Buduj wyniki per stacja
      const result = {};
      stationIdList.forEach((stationId, idx) => {
        const stationName = nameList[idx] || stNames[stationId] || stationId;
        const delayed = [];

        delayedTrains.forEach(t => {
          const stops = t.stations || [];
          const stop  = stops.find(s => String(s.stationId) === String(stationId));
          if (!stop) return;
          if (!isRecent(stop)) return;

          const cancelled = t.trainStatus === 'X';
          const delay     = Math.max(stop.departureDelayMinutes || 0, stop.arrivalDelayMinutes || 0);
          if (!cancelled && delay <= 0) return;

          const r = schedMap[t.orderId] || {};
          const carrierCode = r.carrierCode || '';
          const catSymbol   = r.commercialCategorySymbol || '';

          // Pełna trasa z /schedules/route
          const fullRoute   = routeMap[t.orderId];
          const fullStops   = fullRoute?.stations || fullRoute?.routes?.[0]?.stations || [];
          const allStopNames = dict.stations || {};

          // Pierwsza i ostatnia stacja z pełnej trasy
          let from = '', to = '', via = [];
          if (fullStops.length > 0) {
            const firstId = fullStops[0]?.stationId;
            const lastId  = fullStops[fullStops.length - 1]?.stationId;
            from = firstId ? (allStopNames[firstId]?.name || stationNames[firstId]?.name || '') : '';
            to   = lastId  ? (allStopNames[lastId]?.name  || stationNames[lastId]?.name  || '') : '';
            via  = fullStops
              .slice(1, -1)
              .map(s => (allStopNames[s.stationId]?.name || stationNames[s.stationId]?.name || ''))
              .filter(Boolean);
          } else {
            // Fallback — brak pełnej trasy
            const localFirst = r.stations?.[0]?.stationId;
            const localLast  = r.stations?.[r.stations?.length - 1]?.stationId;
            from = localFirst ? (stationNames[localFirst]?.name || '') : '';
            to   = localLast  ? (stationNames[localLast]?.name  || '') : '';
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
            via,
            plannedTime: stop.plannedDeparture || stop.plannedArrival || '',
            actualTime:  stop.actualDeparture  || stop.actualArrival  || '',
          });
        });

        delayed.sort((a, b) => timeToMinutes(a.plannedTime) - timeToMinutes(b.plannedTime));

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
