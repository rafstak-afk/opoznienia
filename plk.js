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

function sdipGet(stopId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'rj.transportgzm.pl',
      path: '/api/-/sdip/table/' + stopId + '/v2/',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'HX-Request': 'true',
        'HX-Target': 'sdip-time-table-' + stopId,
        'HX-Current-URL': 'https://rj.transportgzm.pl/v2/rozklady/przystanek/stop/' + stopId + '/',
        'Referer': 'https://rj.transportgzm.pl/',
        'Accept': 'text/html',
      }
    };
    const req = https.get(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseSDIP(html, stopId) {
  const departures = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row = rowMatch[1];
    const cells = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(row)) !== null) {
      const text = cellMatch[1].replace(/<[^>]+>/g, '').trim();
      if (text) cells.push(text);
    }
    if (cells.length >= 3) {
      departures.push({ line: cells[0], direction: cells[1], minutes: cells[2] });
    }
  }
  const updateMatch = html.match(/Aktualizacja danych:\s*([^<\n]+)/);
  return { stopId, updated: updateMatch ? updateMatch[1].trim() : '', departures };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  const action = event.queryStringParameters?.action || '';

  try {

    if (action === 'sdip') {
      const stopId = event.queryStringParameters?.stop || '';
      if (!stopId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Brak stop' }) };
      const html = await sdipGet(stopId);
      const result = parseSDIP(html, stopId);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
