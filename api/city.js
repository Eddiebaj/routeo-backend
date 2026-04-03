// api/city.js — Consolidated city data endpoint for RouteO
// Routes by ?type param: foursquare, ottawa, construction, parking
// GET /api/city?type=foursquare&category=restaurants&lat=45.42&lng=-75.69&radius=1500
// GET /api/city?type=ottawa&layer=food_trucks
// GET /api/city?type=construction
// GET /api/city?type=parking
const { checkRateLimit } = require('./_rateLimit');

// ── Foursquare ──────────────────────────────────────────────────

const FSQ_CATEGORY_MAP = {
  coffee: '13035', restaurants: '13065', bars: '13003', gyms: '18021',
  grocery: '17069', pharmacy: '17115', shopping: '17000', parks: '16032',
};
const PRICE_LABELS = { 1: '$', 2: '$$', 3: '$$$', 4: '$$$$' };
const fsqCache = new Map();
const FSQ_CACHE_TTL = 24 * 60 * 60 * 1000;

async function handleFoursquare(req, res) {
  const { lat, lng, category, radius } = req.query;
  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  if (isNaN(latNum) || isNaN(lngNum)) {
    return res.status(400).json({ error: 'lat and lng must be valid numbers' });
  }
  if (!category || !FSQ_CATEGORY_MAP[category]) {
    return res.status(400).json({ error: `Invalid category. Must be one of: ${Object.keys(FSQ_CATEGORY_MAP).join(', ')}` });
  }

  const radiusNum = Math.min(Math.max(parseInt(radius, 10) || 1000, 100), 50000);
  const cacheKey = `${latNum.toFixed(2)}|${lngNum.toFixed(2)}|${category}`;

  const cached = fsqCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < FSQ_CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  const categoryId = FSQ_CATEGORY_MAP[category];
  const url = `https://api.foursquare.com/v3/places/search?ll=${latNum},${lngNum}&categories=${categoryId}&radius=${radiusNum}&limit=20&fields=fsq_id,name,categories,geocodes,location,photos,rating,price,hours,stats`;

  const resp = await fetch(url, {
    headers: { Authorization: process.env.FOURSQUARE_API_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error(`Foursquare API error ${resp.status}:`, text);
    return res.status(502).json({ error: 'Foursquare API error' });
  }

  const data = await resp.json();
  const results = (data.results || []).map(place => {
    const photo = place.photos && place.photos.length > 0 ? place.photos[0] : null;
    return {
      id: place.fsq_id,
      name: place.name || '',
      category,
      lat: place.geocodes?.main?.latitude || null,
      lng: place.geocodes?.main?.longitude || null,
      address: place.location?.formatted_address || place.location?.address || '',
      rating: place.rating || null,
      price: place.price != null ? (PRICE_LABELS[place.price] || null) : null,
      isOpenNow: place.hours?.open_now || false,
      photoUrl: photo ? `${photo.prefix}200x200${photo.suffix}` : null,
      source: 'foursquare',
    };
  });

  fsqCache.set(cacheKey, { ts: Date.now(), data: results });
  return res.status(200).json(results);
}

// ── Ottawa Open Data (ArcGIS) ───────────────────────────────────

const ARCGIS_BASE = 'https://services.arcgis.com/G6F8XLCl5KtAlZ2G/arcgis/rest/services';
const QUERY_SUFFIX = '/FeatureServer/0/query?where=1%3D1&outFields=*&f=json';

const OTTAWA_SOURCES = {
  food_trucks: 'Street_Food_Vendors',
  breweries: 'Ottawa_Craft_Breweries_2023',
  public_art: 'Art_public',
  cultural: 'Organismes_culturels',
  wifi: 'Public_Wi_Fi_Locations',
  bike_repair: 'Bike_Repair',
  ev_chargers: 'Electric_Vehicle_Charging_Stations_Usage_Data',
};

const FARMERS_MARKETS = [
  { id: 'market_lansdowne', name: 'Lansdowne Farmers Market', nameFr: 'March\u00e9 fermier de Lansdowne', lat: 45.4008, lng: -75.6878, days: 'Sunday year-round', hours: '10am-3pm', category: 'markets', source: 'ottawa', subtitle: 'Sunday year-round, 10am-3pm' },
  { id: 'market_main', name: 'Main Street Farmers Market', nameFr: 'March\u00e9 fermier de la rue Main', lat: 45.4089, lng: -75.6721, days: 'Saturday May-Oct', hours: '9am-2pm', category: 'markets', source: 'ottawa', subtitle: 'Saturday May-Oct, 9am-2pm' },
  { id: 'market_westboro', name: 'Westboro Farmers Market', nameFr: 'March\u00e9 fermier de Westboro', lat: 45.3989, lng: -75.7589, days: 'Saturday May-Oct', hours: '9am-3pm', category: 'markets', source: 'ottawa', subtitle: 'Saturday May-Oct, 9am-3pm' },
  { id: 'market_orleans', name: 'Orl\u00e9ans Farmers Market', nameFr: "March\u00e9 fermier d'Orl\u00e9ans", lat: 45.4756, lng: -75.5156, days: 'Thursday May-Oct', hours: '3pm-7pm', category: 'markets', source: 'ottawa', subtitle: 'Thursday May-Oct, 3pm-7pm' },
  { id: 'market_barrhaven', name: 'Barrhaven Farmers Market', nameFr: 'March\u00e9 fermier de Barrhaven', lat: 45.2756, lng: -75.7378, days: 'Sunday May-Oct', hours: '9am-1pm', category: 'markets', source: 'ottawa', subtitle: 'Sunday May-Oct, 9am-1pm' },
];

const ottawaCache = new Map();
const OTTAWA_CACHE_DEFAULT = 24 * 60 * 60 * 1000;
const OTTAWA_CACHE_EV = 60 * 60 * 1000;

function webMercatorToLatLng(x, y) {
  const lng = (x / 20037508.34) * 180;
  let lat = (y / 20037508.34) * 180;
  lat = (180 / Math.PI) * (2 * Math.atan(Math.exp(lat * Math.PI / 180)) - Math.PI / 2);
  return { lat, lng };
}

function normalizeOttawaFeature(type, feature) {
  const attrs = feature.attributes || {};
  const geom = feature.geometry || {};
  let lat = null, lng = null, name = '', subtitle = '', description = '', url = null, photoUrl = null;

  switch (type) {
    case 'food_trucks':
      name = attrs.Trade_Name || attrs.TRADE_NAME || '';
      subtitle = attrs.Location_Description || attrs.LOCATION_DESCRIPTION || '';
      lat = attrs.Latitude || attrs.LATITUDE || null;
      lng = attrs.Longitude || attrs.LONGITUDE || null;
      break;
    case 'breweries':
      name = attrs.Name || attrs.NAME || '';
      subtitle = attrs.Street_Address || attrs.STREET_ADDRESS || '';
      lat = attrs.Latitude || attrs.LATITUDE || null;
      lng = attrs.Longitude || attrs.LONGITUDE || null;
      description = attrs.Beer_Types || attrs.BEER_TYPES || '';
      url = attrs.Website || attrs.WEBSITE || null;
      break;
    case 'public_art':
      name = attrs.ARTWORK || attrs.Artwork || '';
      subtitle = attrs.ARTISTS || attrs.Artists || '';
      lat = attrs.LAT || attrs.Lat || null;
      lng = attrs.LONG || attrs.Long || attrs.LNG || null;
      photoUrl = attrs.IMAGE || attrs.Image || null;
      break;
    case 'cultural': {
      name = attrs.NAME || attrs.Name || '';
      subtitle = attrs.SUB || attrs.Sub || '';
      const loc = attrs.LOCATION || attrs.Location || attrs.ADDRESS || attrs.Address || '';
      if (loc) subtitle = subtitle ? `${subtitle} - ${loc}` : loc;
      break;
    }
    case 'wifi':
      name = attrs.Name || attrs.NAME || '';
      subtitle = attrs.Address || attrs.ADDRESS || '';
      break;
    case 'bike_repair':
      name = attrs.LOCATION_EN || attrs.Location_EN || attrs.NAME || '';
      subtitle = attrs.BUILDING_ADDRESS || attrs.Building_Address || '';
      lat = attrs.Lat || attrs.LAT || null;
      lng = attrs.Long || attrs.LONG || attrs.Lng || null;
      break;
    case 'ev_chargers':
      name = attrs.Station || attrs.STATION || attrs.Name || '';
      subtitle = attrs.Address || attrs.ADDRESS || '';
      break;
  }

  if ((lat == null || lng == null) && geom.x != null && geom.y != null) {
    if (Math.abs(geom.x) > 180 || Math.abs(geom.y) > 90) {
      const c = webMercatorToLatLng(geom.x, geom.y);
      lat = c.lat; lng = c.lng;
    } else {
      lat = geom.y; lng = geom.x;
    }
  }

  const id = attrs.OBJECTID || attrs.ObjectId || attrs.FID || `${type}_${Math.random().toString(36).slice(2, 10)}`;
  return { id: String(id), name, category: type, lat, lng, subtitle, description, url, photoUrl, source: 'ottawa' };
}

async function handleOttawa(req, res) {
  const layer = req.query.layer;
  if (!layer) return res.status(400).json({ error: 'Missing layer param' });

  if (layer === 'markets') return res.status(200).json(FARMERS_MARKETS);

  if (!OTTAWA_SOURCES[layer]) {
    return res.status(400).json({ error: `Invalid layer. Must be one of: ${[...Object.keys(OTTAWA_SOURCES), 'markets'].join(', ')}` });
  }

  const ttl = layer === 'ev_chargers' ? OTTAWA_CACHE_EV : OTTAWA_CACHE_DEFAULT;
  const cached = ottawaCache.get(layer);
  if (cached && Date.now() - cached.ts < ttl) {
    return res.status(200).json(cached.data);
  }

  const url = `${ARCGIS_BASE}/${OTTAWA_SOURCES[layer]}${QUERY_SUFFIX}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'RouteO/1.0' },
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    console.error(`ArcGIS ${layer} error: HTTP ${resp.status}`);
    return res.status(502).json({ error: 'Ottawa data source unavailable' });
  }

  const data = await resp.json();
  const results = (data.features || []).map(f => normalizeOttawaFeature(layer, f)).filter(r => r.name);
  ottawaCache.set(layer, { ts: Date.now(), data: results });
  return res.status(200).json(results);
}

// ── Construction (Road Closures) ────────────────────────────────

const ROAD_CLOSURES_URL = 'https://services.arcgis.com/G6F8XLCl5KtAlZ2G/arcgis/rest/services/RoadClosures/FeatureServer/0/query?where=1%3D1&outFields=*&f=json';
let constructionCached = null;
let constructionCachedAt = 0;
const CONSTRUCTION_CACHE_TTL = 15 * 60 * 1000;

function normalizeConstructionFeature(feature) {
  const attrs = feature.attributes || {};
  const geom = feature.geometry || {};
  const name = attrs.ROAD_NAME || attrs.Road_Name || attrs.road_name || attrs.NAME || attrs.Name || '';
  const description = attrs.DESCRIPTION || attrs.Description || attrs.description || attrs.COMMENTS || attrs.Comments || '';
  const subtitle = attrs.CLOSURE_TYPE || attrs.Closure_Type || attrs.STATUS || attrs.Status || '';
  let lat = attrs.LATITUDE || attrs.Latitude || attrs.LAT || null;
  let lng = attrs.LONGITUDE || attrs.Longitude || attrs.LONG || attrs.LNG || null;

  if ((lat == null || lng == null) && geom.x != null && geom.y != null) {
    if (Math.abs(geom.x) > 180 || Math.abs(geom.y) > 90) {
      const c = webMercatorToLatLng(geom.x, geom.y);
      lat = c.lat; lng = c.lng;
    } else {
      lat = geom.y; lng = geom.x;
    }
  }

  if ((lat == null || lng == null) && geom.paths && geom.paths.length > 0) {
    const path = geom.paths[0];
    if (path && path.length > 0) {
      const mid = path[Math.floor(path.length / 2)];
      if (mid) {
        if (Math.abs(mid[0]) > 180 || Math.abs(mid[1]) > 90) {
          const c = webMercatorToLatLng(mid[0], mid[1]);
          lat = c.lat; lng = c.lng;
        } else {
          lng = mid[0]; lat = mid[1];
        }
      }
    }
  }

  const id = attrs.OBJECTID || attrs.ObjectId || attrs.FID || `construction_${Math.random().toString(36).slice(2, 10)}`;
  return { id: String(id), name, category: 'construction', lat, lng, subtitle, description, source: 'ottawa' };
}

async function handleConstruction(req, res) {
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
  if (constructionCached && Date.now() - constructionCachedAt < CONSTRUCTION_CACHE_TTL) {
    return res.status(200).json(constructionCached);
  }

  const resp = await fetch(ROAD_CLOSURES_URL, {
    headers: { 'User-Agent': 'RouteO/1.0' },
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    console.error(`ArcGIS RoadClosures error: HTTP ${resp.status}`);
    return res.status(200).json([]);
  }

  const data = await resp.json();
  const results = (data.features || []).map(f => normalizeConstructionFeature(f)).filter(r => r.name);
  constructionCached = results;
  constructionCachedAt = Date.now();
  return res.status(200).json(results);
}

// ── Parking ─────────────────────────────────────────────────────

const PARKING_URL = 'https://open.ottawa.ca/api/explore/v2.1/catalog/datasets/parking-garage-availability/records?limit=20';
let parkingCached = null;
let parkingCachedAt = 0;
const PARKING_CACHE_TTL = 5 * 60 * 1000;

async function handleParking(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (parkingCached && Date.now() - parkingCachedAt < PARKING_CACHE_TTL) {
    return res.status(200).json(parkingCached);
  }

  const resp = await fetch(PARKING_URL, {
    headers: { 'User-Agent': 'RouteO/1.0' },
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) {
    console.error(`Ottawa parking API error: HTTP ${resp.status}`);
    return res.status(200).json([]);
  }

  const data = await resp.json();
  const results = (data.results || []).map(r => {
    const total = r.total_capacity || r.capacity || 0;
    const available = r.available_spaces || r.available || 0;
    const percentFull = total > 0 ? Math.round(((total - available) / total) * 100) : null;
    return {
      id: r.garage_id || r.id || r.garage_name || `parking_${Math.random().toString(36).slice(2, 10)}`,
      name: r.garage_name || r.name || 'Garage',
      category: 'parking',
      lat: r.geo_point_2d?.lat || r.latitude || null,
      lng: r.geo_point_2d?.lon || r.longitude || null,
      subtitle: r.address || '',
      available, total, percentFull,
      source: 'ottawa',
    };
  });

  parkingCached = results;
  parkingCachedAt = Date.now();
  return res.status(200).json(results);
}

// ── Gas Prices ──────────────────────────────────────────────────

let gasCachedResult = null;

async function fetchNRCanPrice() {
  const url = 'https://www2.nrcan.gc.ca/eneene/sources/pripri/prices_bycity_e.cfm?productID=1&locationID=66&frequency=D';
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'RouteO/1.0 (Ottawa transit app)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`NRCan HTTP ${resp.status}`);
  const html = await resp.text();

  const priceMatch = html.match(/<td[^>]*>\s*(\d{2,3}\.\d)\s*<\/td>/);
  if (priceMatch) {
    const raw = parseFloat(priceMatch[1]);
    if (raw > 50 && raw < 300) return raw.toFixed(1);
  }

  const altMatch = html.match(/(\d{2,3}\.\d{1,2})\s*\u00a2/);
  if (altMatch) return parseFloat(altMatch[1]).toFixed(1);

  const ottawaIdx = html.toLowerCase().indexOf('ottawa');
  if (ottawaIdx > -1) {
    const nearby = html.slice(ottawaIdx, ottawaIdx + 500);
    const numMatch = nearby.match(/\b(1[2-9]\d\.\d)\b/);
    if (numMatch) return parseFloat(numMatch[1]).toFixed(1);
  }

  throw new Error('Could not parse price from NRCan response');
}

async function handleGas(req, res) {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  try {
    const price = await fetchNRCanPrice();
    const result = {
      price,
      city: 'Ottawa',
      currency: 'CAD',
      unit: 'cents/L',
      source: 'NRCan',
      updated: new Date().toISOString().split('T')[0],
      stations: [],
    };
    gasCachedResult = { price, updated: new Date().toISOString() };
    return res.status(200).json(result);
  } catch (err) {
    console.error('Gas price fetch failed:', err);
    if (gasCachedResult) return res.status(200).json({ ...gasCachedResult, stale: true });
    return res.status(500).json({ error: 'Could not fetch gas prices' });
  }
}

// ── Router ──────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (await checkRateLimit(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type } = req.query;
  if (!type) return res.status(400).json({ error: 'Missing type param (foursquare|ottawa|construction|parking|gas)' });

  try {
    switch (type) {
      case 'foursquare': return await handleFoursquare(req, res);
      case 'ottawa': return await handleOttawa(req, res);
      case 'construction': return await handleConstruction(req, res);
      case 'parking': return await handleParking(req, res);
      case 'gas': return await handleGas(req, res);
      default: return res.status(400).json({ error: `Unknown type: ${type}` });
    }
  } catch (err) {
    console.error(`City ${type} error:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
