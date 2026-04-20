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

  try {
    const action = event.queryStringParameters?.action || 'delays';

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

      // Pobierz bez fullRoutes — mniejszy payload, szybciej
      // withPlanned=true potrzebne do pól *DelayMinutes
      const data = await plkGet(
        '/operations?stations=' + ids + '&withPlanned=true&fullRoutes=true&pageSize=500'
      );

      const trains  = data.trains || [];
      if (event.queryStringParameters?.raw === 'true') {
  return { statusCode: 200, headers, body: JSON.stringify(data.trains?.[0] || {}) };
}
      const stNames = data.stations || {}; // mapa id->nazwa stacji z odpowiedzi

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

          delayed.push({
            cancelled,
            delay,
            trainNumber: t.trainNumber || t.orderId || '—',
            category:    t.commercialCategoryName || t.category || '',
            carrier:     t.carrierShortName || t.carrier || '',
            from:        t.startStationName || '',
            to:          t.endStationName   || '',
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
