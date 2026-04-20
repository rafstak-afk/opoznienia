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
        catch(e) { reject(new Error('Błąd: ' + data.slice(0, 100))); }
      });
    }).on('error', reject);
  });
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

    if (action === 'route') {
      const ids = event.queryStringParameters?.ids || '';
      const num = event.queryStringParameters?.num || '';
      const today = new Date().toISOString().slice(0, 10);
      const sched = await plkGet('/schedules?stations=' + ids + '&dateFrom=' + today + '&dateTo=' + today + '&pageSize=500');
      const found = (sched.routes || []).find(r => r.nationalNumber === num);
      if (!found) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Nie znaleziono' }) };
      const route = await plkGet('/schedules/route/' + found.scheduleId + '/' + found.orderId);
      return { statusCode: 200, headers, body: JSON.stringify({ train: found, route, dict: sched.dictionaries }) };
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
          const fullRoute  = routeMap[t.orderId];
          const fullStops  = fullRoute?.stations || [];
          // Każde route ma własny dict.stations z wszystkimi stacjami tej trasy
          const routeDict  = fullRoute?.dictionaries?.stations || fullRoute?.dict?.stations || {};
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

      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
