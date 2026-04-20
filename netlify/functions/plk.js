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

      // Słowniki z rozkładu
      const dict         = schedData.dictionaries || {};
      const stationNames = dict.stations   || {};  // {id: {id, name}}
      const carrierNames = dict.carriers   || {};  // {code: name}
      const catNames     = dict.commercialCategories || {};

      // Mapa orderId -> dane z rozkładu
      const schedMap = {};
      routes.forEach(r => { schedMap[r.orderId] = r; });

      const result = {};
      stationIdList.forEach((stationId, idx) => {
        const stationName = nameList[idx] || stNames[stationId] || stationId;
        const delayed = [];

        trains.forEach(t => {
          if (t.trainStatus === 'C') return;
          const stops = t.stations || [];
          const stop  = stops.find(s => String(s.stationId) === String(stationId));
          if (!stop) return;

          const cancelled = t.trainStatus === 'X';
          const delay     = Math.max(stop.departureDelayMinutes || 0, stop.arrivalDelayMinutes || 0);
          if (!cancelled && delay <= 0) return;

          const r = schedMap[t.orderId] || {};

          // Stacje pośrednie z rozkładu dla tej trasy (wszystkie oprócz pierwszej i ostatniej)
          const routeStops  = r.stations || [];
          const firstStopId = routeStops[0]?.stationId;
          const lastStopId  = routeStops[routeStops.length - 1]?.stationId;
          const from = firstStopId ? (stationNames[firstStopId]?.name || '') : '';
          const to   = lastStopId  ? (stationNames[lastStopId]?.name  || '') : '';
          const via  = routeStops
            .slice(1, -1)
            .map(s => stationNames[s.stationId]?.name || '')
            .filter(Boolean);

          // Pełna nazwa przewoźnika i kategorii
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
