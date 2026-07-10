'use strict';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

const ROAD_FILTER = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service';
const FETCH_RADIUS_M = 180;
const REFRESH_DISTANCE_M = 110;
const REFRESH_INTERVAL_MS = 22000;
const STALE_LIMIT_MS = 15000;
const MAX_MATCH_DISTANCE_M = 55;

const els = {
  speed: document.getElementById('speed'),
  limit: document.getElementById('limit'),
  limitSign: document.getElementById('limitSign'),
  hero: document.getElementById('hero'),
  statusPill: document.getElementById('statusPill'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  soundToggle: document.getElementById('soundToggle'),
  confidenceBadge: document.getElementById('confidenceBadge'),
  roadName: document.getElementById('roadName'),
  limitSource: document.getElementById('limitSource'),
  areaText: document.getElementById('areaText'),
  accuracyText: document.getElementById('accuracyText'),
  dataStatus: document.getElementById('dataStatus'),
  conditionalNote: document.getElementById('conditionalNote'),
  delta: document.getElementById('delta'),
  fine: document.getElementById('fine'),
  points: document.getElementById('points'),
  ban: document.getElementById('ban'),
  fineNote: document.getElementById('fineNote'),
  quickLimits: document.getElementById('quickLimits'),
  clearOverrideBtn: document.getElementById('clearOverrideBtn')
};

const state = {
  watchId: null,
  wakeLock: null,
  audioContext: null,
  currentPosition: null,
  previousPosition: null,
  currentSpeedKmh: 0,
  speedSamples: [],
  heading: null,
  roads: [],
  lastFetchAt: 0,
  lastFetchCenter: null,
  fetchInFlight: false,
  activeMatch: null,
  pendingRoadId: null,
  pendingRoadCount: 0,
  lastGoodMatchAt: 0,
  override: null,
  overrideRoadId: null,
  lastAlertAt: 0,
  lastAlertBand: 0,
  statusMessage: 'Bereit'
};

const fineTable = {
  urban: [
    {max:10,fine:30,points:0,ban:0},
    {max:15,fine:50,points:0,ban:0},
    {max:20,fine:70,points:0,ban:0},
    {max:25,fine:115,points:1,ban:0},
    {max:30,fine:180,points:1,ban:0},
    {max:40,fine:260,points:2,ban:1},
    {max:50,fine:400,points:2,ban:1},
    {max:60,fine:560,points:2,ban:2},
    {max:70,fine:700,points:2,ban:3},
    {max:Infinity,fine:800,points:2,ban:3}
  ],
  rural: [
    {max:10,fine:20,points:0,ban:0},
    {max:15,fine:40,points:0,ban:0},
    {max:20,fine:60,points:0,ban:0},
    {max:25,fine:100,points:1,ban:0},
    {max:30,fine:150,points:1,ban:0},
    {max:40,fine:200,points:1,ban:0},
    {max:50,fine:320,points:2,ban:1},
    {max:60,fine:480,points:2,ban:1},
    {max:70,fine:600,points:2,ban:2},
    {max:Infinity,fine:700,points:2,ban:3}
  ]
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toRad(value) {
  return value * Math.PI / 180;
}

function toDeg(value) {
  return value * 180 / Math.PI;
}

function haversineMeters(aLat, aLon, bLat, bLon) {
  const radius = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

function bearingDegrees(aLat, aLon, bLat, bLon) {
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const dLon = toRad(bLon - aLon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function angleDifference(a, b) {
  const diff = Math.abs(((a - b + 540) % 360) - 180);
  return diff;
}

function projectPoint(lat, lon, refLat, refLon) {
  const radius = 6371000;
  return {
    x: toRad(lon - refLon) * Math.cos(toRad(refLat)) * radius,
    y: toRad(lat - refLat) * radius
  };
}

function pointToSegmentDistance(point, a, b) {
  const abX = b.x - a.x;
  const abY = b.y - a.y;
  const lengthSq = abX * abX + abY * abY;
  if (lengthSq === 0) return {distance: Math.hypot(point.x - a.x, point.y - a.y), t: 0};
  const t = clamp(((point.x - a.x) * abX + (point.y - a.y) * abY) / lengthSq, 0, 1);
  const closestX = a.x + t * abX;
  const closestY = a.y + t * abY;
  return {distance: Math.hypot(point.x - closestX, point.y - closestY), t};
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeName(tags = {}) {
  return tags.name || tags.ref || roadTypeLabel(tags.highway) || 'Unbekannte Straße';
}

function roadTypeLabel(type) {
  const labels = {
    motorway: 'Autobahn', motorway_link: 'Autobahnauffahrt', trunk: 'Schnellstraße', trunk_link: 'Schnellstraßen-Zubringer',
    primary: 'Hauptstraße', primary_link: 'Hauptstraßen-Zubringer', secondary: 'Landes-/Kreisstraße', secondary_link: 'Zubringer',
    tertiary: 'Verbindungsstraße', tertiary_link: 'Zubringer', unclassified: 'Straße', residential: 'Wohnstraße',
    living_street: 'Verkehrsberuhigter Bereich', service: 'Zufahrt'
  };
  return labels[type] || null;
}

function isOneWay(tags = {}) {
  if (tags.oneway === '-1') return -1;
  if (tags.oneway === 'yes' || tags.oneway === '1' || tags.junction === 'roundabout') return 1;
  return 0;
}

function roadClassPenalty(tags = {}) {
  const order = {
    motorway: 0, motorway_link: 1, trunk: 1, trunk_link: 2, primary: 2, primary_link: 3,
    secondary: 3, secondary_link: 4, tertiary: 4, tertiary_link: 5, unclassified: 6,
    residential: 7, living_street: 8, service: 11
  };
  let penalty = order[tags.highway] ?? 12;
  if (tags.service === 'parking_aisle' || tags.service === 'driveway') penalty += 15;
  if (tags.access === 'private' || tags.access === 'no') penalty += 40;
  return penalty * 0.18;
}

function findBestRoadMatch(position) {
  if (!position || !state.roads.length) return null;
  const {latitude, longitude, accuracy} = position.coords;
  const point = {x: 0, y: 0};
  const candidates = [];

  for (const road of state.roads) {
    if (!Array.isArray(road.geometry) || road.geometry.length < 2) continue;
    let bestSegment = null;

    for (let i = 0; i < road.geometry.length - 1; i += 1) {
      const first = road.geometry[i];
      const second = road.geometry[i + 1];
      const a = projectPoint(first.lat, first.lon, latitude, longitude);
      const b = projectPoint(second.lat, second.lon, latitude, longitude);
      const closest = pointToSegmentDistance(point, a, b);
      if (!bestSegment || closest.distance < bestSegment.distance) {
        bestSegment = {
          distance: closest.distance,
          segmentBearing: bearingDegrees(first.lat, first.lon, second.lat, second.lon),
          segmentIndex: i
        };
      }
    }

    if (!bestSegment) continue;
    const oneway = isOneWay(road.tags);
    const usableHeading = state.heading != null && state.currentSpeedKmh >= 7;
    let direction = 'unknown';
    let headingDiff = 0;

    if (usableHeading) {
      const forwardDiff = angleDifference(state.heading, bestSegment.segmentBearing);
      const backwardDiff = angleDifference(state.heading, (bestSegment.segmentBearing + 180) % 360);
      if (oneway === 1) {
        direction = 'forward';
        headingDiff = forwardDiff;
      } else if (oneway === -1) {
        direction = 'backward';
        headingDiff = backwardDiff;
      } else if (forwardDiff <= backwardDiff) {
        direction = 'forward';
        headingDiff = forwardDiff;
      } else {
        direction = 'backward';
        headingDiff = backwardDiff;
      }
    }

    const headingPenalty = usableHeading ? Math.max(0, headingDiff - 15) * 0.72 : 0;
    const wrongWayPenalty = usableHeading && oneway !== 0 && headingDiff > 95 ? 80 : 0;
    const accuracyPenalty = Math.max(0, (accuracy || 0) - 18) * 0.08;
    const score = bestSegment.distance + headingPenalty + wrongWayPenalty + roadClassPenalty(road.tags) + accuracyPenalty;

    candidates.push({
      road,
      distance: bestSegment.distance,
      score,
      headingDiff,
      direction,
      segmentBearing: bestSegment.segmentBearing
    });
  }

  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  const allowedDistance = Math.min(MAX_MATCH_DISTANCE_M, Math.max(24, (position.coords.accuracy || 15) * 1.25));
  if (!best || best.distance > allowedDistance) return null;
  return best;
}

function parseNumericSpeed(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  if (text === 'none' || text === 'unlimited' || text === 'de:motorway') return {kind:'unlimited', value:null, raw:value};
  if (text === 'walk' || text === 'de:living_street') return {kind:'numeric', value:7, raw:value};
  if (text === 'signals' || text === 'variable') return {kind:'unknown', value:null, raw:value};

  const mphValues = [...text.matchAll(/(\d+(?:\.\d+)?)\s*mph/g)].map(match => Math.round(Number(match[1]) * 1.609344));
  if (mphValues.length) return {kind:'numeric', value:Math.min(...mphValues), raw:value};

  const values = [...text.matchAll(/(?:^|[;|,\s])(\d{1,3})(?=$|[;|,\s])/g)].map(match => Number(match[1]));
  if (values.length) return {kind:'numeric', value:Math.min(...values), raw:value};

  const single = text.match(/\d{1,3}/);
  if (single) return {kind:'numeric', value:Number(single[0]), raw:value};
  return null;
}

function parseGermanDefault(value) {
  if (!value) return null;
  const text = String(value).toUpperCase().trim();
  const zoneMatch = text.match(/DE:ZONE:?([0-9]{1,3})/);
  if (zoneMatch) return {kind:'numeric', value:Number(zoneMatch[1]), area:'urban', source:'OSM-Zonenregel'};
  if (text.includes('DE:URBAN')) return {kind:'numeric', value:50, area:'urban', source:'Deutsches Standardlimit innerorts'};
  if (text.includes('DE:RURAL')) return {kind:'numeric', value:100, area:'rural', source:'Deutsches Standardlimit außerorts'};
  if (text.includes('DE:MOTORWAY')) return {kind:'unlimited', value:null, area:'rural', source:'Autobahn ohne eingetragenes Limit'};
  if (text.includes('DE:LIVING_STREET')) return {kind:'numeric', value:7, area:'urban', source:'Verkehrsberuhigter Bereich'};
  return null;
}

function parseTimeRangeCondition(condition, now = new Date()) {
  const normalized = condition.replace(/[()]/g, ' ').trim();
  if (/wet|snow|ice|school|weight|sunrise|sunset|holiday|ph|sh/i.test(normalized)) return null;

  let dayMatch = normalized.match(/\b(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?\b/i);
  if (dayMatch) {
    const days = ['Su','Mo','Tu','We','Th','Fr','Sa'];
    const current = now.getDay();
    const start = days.findIndex(day => day.toLowerCase() === dayMatch[1].toLowerCase());
    const end = dayMatch[2] ? days.findIndex(day => day.toLowerCase() === dayMatch[2].toLowerCase()) : start;
    const validDay = start <= end ? current >= start && current <= end : current >= start || current <= end;
    if (!validDay) return false;
  }

  const timeMatch = normalized.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (timeMatch) {
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
    const endMinutes = Number(timeMatch[3]) * 60 + Number(timeMatch[4]);
    return startMinutes <= endMinutes
      ? currentMinutes >= startMinutes && currentMinutes <= endMinutes
      : currentMinutes >= startMinutes || currentMinutes <= endMinutes;
  }

  return dayMatch ? true : null;
}

function evaluateConditionalSpeed(value) {
  if (!value) return {active:null, note:null};
  const parts = String(value).split(/;(?=\s*(?:\d|none|walk))/);
  for (const part of parts) {
    const match = part.match(/^\s*([^@]+?)\s*@\s*\((.+)\)\s*$/);
    if (!match) continue;
    const parsed = parseNumericSpeed(match[1]);
    const conditionResult = parseTimeRangeCondition(match[2]);
    if (parsed && conditionResult === true) {
      return {active:parsed, note:`Zeitabhängiges OSM-Limit aktiv: ${part.trim()}`};
    }
    if (conditionResult == null) {
      return {active:null, note:`Bedingtes OSM-Limit vorhanden (${part.trim()}). Zusatzschild prüfen.`};
    }
  }
  return {active:null, note:`Bedingtes OSM-Limit vorhanden (${value}). Zusatzschild prüfen.`};
}

function inferArea(tags, defaultToken, highway) {
  const token = String(defaultToken || '').toUpperCase();
  if (token.includes('URBAN') || token.includes('ZONE') || token.includes('LIVING_STREET')) return 'urban';
  if (token.includes('RURAL') || token.includes('MOTORWAY')) return 'rural';
  if (highway === 'living_street' || highway === 'residential') return 'urban';
  if (highway === 'motorway' || highway === 'motorway_link') return 'rural';
  if (tags.lit === 'yes' || tags.sidewalk === 'both' || tags.sidewalk === 'left' || tags.sidewalk === 'right') return 'urban';
  if (tags.lit === 'no') return 'rural';
  return 'unknown';
}

function resolveRoadLimit(match) {
  if (!match) return null;
  const tags = match.road.tags || {};
  const direction = match.direction;
  const directionalKey = direction === 'forward' ? 'maxspeed:forward' : direction === 'backward' ? 'maxspeed:backward' : null;
  const directionalConditionalKey = direction === 'forward' ? 'maxspeed:forward:conditional' : direction === 'backward' ? 'maxspeed:backward:conditional' : null;
  const defaultToken = tags['maxspeed:type'] || tags['source:maxspeed'] || tags['zone:maxspeed'];
  let parsed = null;
  let source = null;
  let confidence = 'high';
  let conditionalNote = null;

  const conditional = evaluateConditionalSpeed(
    (directionalConditionalKey && tags[directionalConditionalKey]) || tags['maxspeed:conditional']
  );
  if (conditional.active) {
    parsed = conditional.active;
    source = 'Zeitabhängiges OSM-Limit';
    conditionalNote = conditional.note;
  }

  if (!parsed && directionalKey && tags[directionalKey]) {
    parsed = parseNumericSpeed(tags[directionalKey]);
    source = direction === 'forward' ? 'OSM-Limit in Fahrtrichtung' : 'OSM-Limit entgegen der OSM-Wegrichtung';
  }

  if (!parsed && tags['maxspeed:motorcar']) {
    parsed = parseNumericSpeed(tags['maxspeed:motorcar']);
    source = 'OSM-Limit für Pkw';
  }

  if (!parsed && tags.maxspeed) {
    parsed = parseNumericSpeed(tags.maxspeed);
    source = 'Explizites OSM-Tempolimit';
  }

  if (!parsed && tags['zone:maxspeed']) {
    parsed = parseNumericSpeed(tags['zone:maxspeed']);
    if (parsed) {
      source = 'OSM-Zonenlimit';
      confidence = 'medium';
    }
  }

  if (!parsed) {
    const defaultParsed = parseGermanDefault(defaultToken);
    if (defaultParsed) {
      parsed = defaultParsed;
      source = defaultParsed.source;
      confidence = 'medium';
    }
  }

  if (!parsed && tags.highway === 'living_street') {
    parsed = {kind:'numeric', value:7};
    source = 'Straßentyp: verkehrsberuhigter Bereich';
    confidence = 'medium';
  }

  if (!parsed && tags.highway === 'motorway') {
    parsed = {kind:'unlimited', value:null};
    source = 'Deutsche Autobahn: kein OSM-Limit eingetragen';
    confidence = 'low';
  }

  if (!parsed && tags.highway === 'residential') {
    parsed = {kind:'numeric', value:50};
    source = 'Abgeleitet aus Wohnstraße (innerorts)';
    confidence = 'low';
  }

  if (!parsed && tags.lit === 'yes' && !['service','motorway','motorway_link'].includes(tags.highway)) {
    parsed = {kind:'numeric', value:50};
    source = 'Abgeleitet aus beleuchteter Straße (innerorts wahrscheinlich)';
    confidence = 'low';
  }

  if (!parsed && tags.lit === 'no' && !['service','motorway','motorway_link'].includes(tags.highway)) {
    parsed = {kind:'numeric', value:100};
    source = 'Abgeleitet aus unbeleuchteter Straße (außerorts wahrscheinlich)';
    confidence = 'low';
  }

  if (!parsed) {
    return {
      kind:'unknown', value:null, source:'Kein belastbares Tempolimit in OSM', confidence:'unknown',
      area:inferArea(tags, defaultToken, tags.highway), conditionalNote:conditional.note, raw:null
    };
  }

  if (!conditionalNote) conditionalNote = conditional.note;
  const area = parsed.area || inferArea(tags, defaultToken, tags.highway);
  return {
    kind:parsed.kind,
    value:parsed.value,
    raw:parsed.raw || null,
    source,
    confidence,
    area,
    conditionalNote
  };
}

function confidenceForMatch(match, limitInfo, accuracy) {
  if (!match || !limitInfo || limitInfo.kind === 'unknown') return 'unknown';
  let score = 3;
  if (limitInfo.confidence === 'medium') score -= 1;
  if (limitInfo.confidence === 'low') score -= 2;
  if (match.distance > 24) score -= 1;
  if (state.heading != null && state.currentSpeedKmh >= 7 && match.headingDiff > 35) score -= 1;
  if ((accuracy || 0) > 30) score -= 1;
  if (limitInfo.conditionalNote) score -= 1;
  if (score >= 3) return 'high';
  if (score >= 1) return 'medium';
  return 'low';
}

function shouldRefreshRoads(position) {
  if (!state.lastFetchCenter) return true;
  const moved = haversineMeters(
    state.lastFetchCenter.latitude,
    state.lastFetchCenter.longitude,
    position.coords.latitude,
    position.coords.longitude
  );
  return moved >= REFRESH_DISTANCE_M || Date.now() - state.lastFetchAt >= REFRESH_INTERVAL_MS;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {...options, signal: controller.signal});
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRoads(position) {
  if (state.fetchInFlight || !position) return;
  const {latitude, longitude} = position.coords;
  state.fetchInFlight = true;
  state.lastFetchAt = Date.now();
  state.lastFetchCenter = {latitude, longitude};
  state.statusMessage = 'Kartendaten werden geladen';
  render();

  const query = `[out:json][timeout:10];way(around:${FETCH_RADIUS_M},${latitude},${longitude})["highway"~"^(${ROAD_FILTER})$"];out tags geom;`;
  let lastError = null;

  for (let i = 0; i < OVERPASS_ENDPOINTS.length; i += 1) {
    try {
      const response = await fetchWithTimeout(
        OVERPASS_ENDPOINTS[i],
        {
          method:'POST',
          headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},
          body:`data=${encodeURIComponent(query)}`
        },
        9000
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      state.roads = (data.elements || []).filter(element => element.type === 'way' && Array.isArray(element.geometry));
      state.lastFetchAt = Date.now();
      state.lastFetchCenter = {latitude, longitude};
      state.statusMessage = state.roads.length ? `${state.roads.length} Straßen geprüft` : 'Keine Straßen gefunden';
      state.fetchInFlight = false;
      updateRoadMatch();
      render();
      return;
    } catch (error) {
      lastError = error;
    }
  }

  state.fetchInFlight = false;
  state.statusMessage = state.roads.length ? 'Netzfehler · letzte Kartendaten aktiv' : 'Kartendienst nicht erreichbar';
  console.warn('Overpass request failed', lastError);
  render();
}

function applyStableMatch(candidate) {
  if (!candidate) {
    if (Date.now() - state.lastGoodMatchAt > STALE_LIMIT_MS) state.activeMatch = null;
    return;
  }

  const candidateId = candidate.road.id;
  const currentId = state.activeMatch?.road?.id;
  if (candidateId === currentId || candidate.distance <= 8) {
    state.activeMatch = candidate;
    state.pendingRoadId = null;
    state.pendingRoadCount = 0;
    state.lastGoodMatchAt = Date.now();
    return;
  }

  if (state.pendingRoadId === candidateId) state.pendingRoadCount += 1;
  else {
    state.pendingRoadId = candidateId;
    state.pendingRoadCount = 1;
  }

  if (state.pendingRoadCount >= 2 || !state.activeMatch) {
    const oldRoadId = state.activeMatch?.road?.id;
    state.activeMatch = candidate;
    state.lastGoodMatchAt = Date.now();
    state.pendingRoadId = null;
    state.pendingRoadCount = 0;
    if (oldRoadId && oldRoadId !== candidateId && state.overrideRoadId !== candidateId) clearOverride(false);
  }
}

function updateRoadMatch() {
  if (!state.currentPosition) return;
  const candidate = findBestRoadMatch(state.currentPosition);
  applyStableMatch(candidate);
}

function estimateSpeed(position) {
  const directSpeed = position.coords.speed;
  let speedMps = Number.isFinite(directSpeed) && directSpeed >= 0 ? directSpeed : null;

  if (speedMps == null && state.previousPosition) {
    const elapsedSeconds = (position.timestamp - state.previousPosition.timestamp) / 1000;
    if (elapsedSeconds >= 0.7 && elapsedSeconds <= 6) {
      const distance = haversineMeters(
        state.previousPosition.coords.latitude,
        state.previousPosition.coords.longitude,
        position.coords.latitude,
        position.coords.longitude
      );
      const noiseThreshold = Math.max(3, Math.min(position.coords.accuracy || 20, state.previousPosition.coords.accuracy || 20) * 0.22);
      if (distance >= noiseThreshold) speedMps = distance / elapsedSeconds;
    }
  }

  const speedKmh = clamp((speedMps || 0) * 3.6, 0, 260);
  state.speedSamples.push(speedKmh);
  if (state.speedSamples.length > 5) state.speedSamples.shift();
  return median(state.speedSamples);
}

function estimateHeading(position) {
  const directHeading = position.coords.heading;
  if (Number.isFinite(directHeading) && directHeading >= 0 && state.currentSpeedKmh >= 4) return directHeading;
  if (!state.previousPosition) return state.heading;
  const distance = haversineMeters(
    state.previousPosition.coords.latitude,
    state.previousPosition.coords.longitude,
    position.coords.latitude,
    position.coords.longitude
  );
  if (distance < 5) return state.heading;
  return bearingDegrees(
    state.previousPosition.coords.latitude,
    state.previousPosition.coords.longitude,
    position.coords.latitude,
    position.coords.longitude
  );
}

function currentLimitState() {
  const roadLimit = resolveRoadLimit(state.activeMatch);
  const activeRoadId = state.activeMatch?.road?.id || null;
  if (state.override && (!state.overrideRoadId || state.overrideRoadId === activeRoadId)) {
    return {
      ...state.override,
      source:'Temporäre Schild-Korrektur',
      confidence:'high',
      area:roadLimit?.area || 'unknown',
      conditionalNote:null,
      overridden:true
    };
  }
  return roadLimit;
}

function calculateFine(delta, area) {
  if (delta <= 0) return {fine:0, points:0, ban:0, areaUsed:area};
  const areaUsed = area === 'urban' ? 'urban' : 'rural';
  const row = fineTable[areaUsed].find(entry => delta <= entry.max);
  return {...row, areaUsed};
}

function calculatePenaltyView(delta, area) {
  if (area !== 'unknown') return {primary:calculateFine(delta, area), range:null};
  const urban = calculateFine(delta, 'urban');
  const rural = calculateFine(delta, 'rural');
  return {
    primary:urban.fine >= rural.fine ? urban : rural,
    range:{urban, rural}
  };
}

function areaLabel(area) {
  if (area === 'urban') return 'Innerorts';
  if (area === 'rural') return 'Außerorts';
  return 'Nicht sicher erkannt';
}

function limitDisplay(limitInfo) {
  if (!limitInfo || limitInfo.kind === 'unknown') return '—';
  if (limitInfo.kind === 'unlimited') return 'frei';
  return String(Math.round(limitInfo.value));
}

function alertBand(delta) {
  if (delta >= 21) return 3;
  if (delta >= 10) return 2;
  if (delta >= 4) return 1;
  return 0;
}

function ensureAudioContext() {
  if (!state.audioContext) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) state.audioContext = new AudioContext();
  }
  if (state.audioContext?.state === 'suspended') state.audioContext.resume().catch(() => {});
}

function beep(frequency = 720, duration = 0.12) {
  if (!state.audioContext) return;
  const oscillator = state.audioContext.createOscillator();
  const gain = state.audioContext.createGain();
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, state.audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.18, state.audioContext.currentTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, state.audioContext.currentTime + duration);
  oscillator.connect(gain);
  gain.connect(state.audioContext.destination);
  oscillator.start();
  oscillator.stop(state.audioContext.currentTime + duration + 0.02);
}

function maybeAlert(delta) {
  const band = alertBand(delta);
  if (!els.soundToggle.checked || band === 0) {
    state.lastAlertBand = band;
    return;
  }
  const now = Date.now();
  const crossedBand = band > state.lastAlertBand;
  const repeatDue = now - state.lastAlertAt > 16000;
  if (crossedBand || repeatDue) {
    ensureAudioContext();
    beep(band === 3 ? 940 : band === 2 ? 820 : 700, band === 3 ? 0.2 : 0.13);
    state.lastAlertAt = now;
  }
  state.lastAlertBand = band;
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
  } catch (error) {
    console.info('Wake Lock unavailable', error);
  }
}

async function releaseWakeLock() {
  try {
    await state.wakeLock?.release();
  } catch (_) {}
  state.wakeLock = null;
}

function onPosition(position) {
  state.currentPosition = position;
  state.currentSpeedKmh = estimateSpeed(position);
  state.heading = estimateHeading(position);
  updateRoadMatch();

  if ((position.coords.accuracy || 999) <= 65 && shouldRefreshRoads(position)) {
    fetchRoads(position);
  }

  state.previousPosition = position;
  render();
}

function onPositionError(error) {
  const messages = {
    1:'Standortzugriff abgelehnt',
    2:'GPS-Position nicht verfügbar',
    3:'GPS-Zeitüberschreitung'
  };
  state.statusMessage = messages[error.code] || error.message || 'Standortfehler';
  render();
}

function startTracking() {
  if (!('geolocation' in navigator)) {
    alert('Dieser Browser unterstützt keine GPS-Ortung. Bitte Safari auf dem iPhone verwenden.');
    return;
  }
  ensureAudioContext();
  requestWakeLock();
  state.speedSamples = [];
  state.statusMessage = 'GPS wird gestartet';
  state.watchId = navigator.geolocation.watchPosition(
    onPosition,
    onPositionError,
    {enableHighAccuracy:true, maximumAge:750, timeout:15000}
  );
  els.startBtn.disabled = true;
  els.stopBtn.disabled = false;
  render();
}

function stopTracking() {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  state.currentSpeedKmh = 0;
  state.speedSamples = [];
  state.statusMessage = 'Gestoppt';
  state.lastAlertBand = 0;
  releaseWakeLock();
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  render();
}

function setOverride(rawValue) {
  const value = rawValue === 'none' ? null : Number(rawValue);
  state.override = rawValue === 'none'
    ? {kind:'unlimited', value:null}
    : {kind:'numeric', value};
  state.overrideRoadId = state.activeMatch?.road?.id || null;
  els.clearOverrideBtn.disabled = false;
  [...els.quickLimits.querySelectorAll('button')].forEach(button => {
    button.classList.toggle('active', button.dataset.limit === String(rawValue));
  });
  render();
}

function clearOverride(shouldRender = true) {
  state.override = null;
  state.overrideRoadId = null;
  els.clearOverrideBtn.disabled = true;
  [...els.quickLimits.querySelectorAll('button')].forEach(button => button.classList.remove('active'));
  if (shouldRender) render();
}

function render() {
  const tracking = state.watchId !== null;
  const limitInfo = currentLimitState();
  const accuracy = state.currentPosition?.coords?.accuracy;
  const confidence = confidenceForMatch(state.activeMatch, limitInfo, accuracy);
  const numericLimit = limitInfo?.kind === 'numeric' ? limitInfo.value : null;
  const delta = numericLimit == null ? 0 : Math.max(0, Math.floor(state.currentSpeedKmh - numericLimit));
  const penaltyView = calculatePenaltyView(delta, limitInfo?.area || 'unknown');
  const penalty = penaltyView.primary;
  const band = alertBand(delta);
  const visualState = !tracking ? 'idle' : band >= 3 ? 'danger' : band >= 1 ? 'warn' : 'ok';

  els.speed.textContent = String(Math.round(state.currentSpeedKmh));
  els.limit.textContent = limitDisplay(limitInfo);
  els.limitSign.className = `limitSign ${!limitInfo || limitInfo.kind === 'unknown' ? 'unknown' : limitInfo.kind === 'unlimited' ? 'unlimited' : ''}`.trim();
  els.hero.className = `hero ${visualState}`;
  els.statusPill.className = `pill ${visualState}`;
  els.statusPill.textContent = tracking
    ? (!limitInfo || limitInfo.kind === 'unknown' ? 'Limit offen' : delta > 0 ? `+${delta} km/h` : 'Im Limit')
    : 'Bereit';

  const tags = state.activeMatch?.road?.tags || {};
  els.roadName.textContent = state.activeMatch
    ? `${normalizeName(tags)}${tags.ref && tags.name ? ` · ${tags.ref}` : ''}`
    : tracking ? 'Straße wird erkannt …' : 'Noch keine Straße erkannt.';
  els.limitSource.textContent = limitInfo?.source || '—';
  els.areaText.textContent = areaLabel(limitInfo?.area || 'unknown');
  els.accuracyText.textContent = Number.isFinite(accuracy) ? `± ${Math.round(accuracy)} m` : '—';
  els.dataStatus.textContent = state.fetchInFlight ? 'Lädt …' : state.statusMessage;
  els.confidenceBadge.className = `confidence ${confidence}`;
  els.confidenceBadge.textContent = confidence === 'high' ? 'Hohe Sicherheit' : confidence === 'medium' ? 'Mittlere Sicherheit' : confidence === 'low' ? 'Niedrige Sicherheit' : 'Nicht erkannt';

  if (limitInfo?.conditionalNote) {
    els.conditionalNote.textContent = limitInfo.conditionalNote;
    els.conditionalNote.classList.remove('hidden');
  } else {
    els.conditionalNote.textContent = '';
    els.conditionalNote.classList.add('hidden');
  }

  if (!limitInfo || limitInfo.kind === 'unknown') {
    els.delta.textContent = '—';
    els.fine.textContent = '—';
    els.points.textContent = '—';
    els.ban.textContent = '—';
    els.fineNote.textContent = 'Noch kein belastbares Tempolimit erkannt. Bitte Beschilderung beachten.';
  } else if (limitInfo.kind === 'unlimited') {
    els.delta.textContent = '0 km/h';
    els.fine.textContent = '0 €';
    els.points.textContent = '0';
    els.ban.textContent = 'Nein';
    els.fineNote.textContent = 'OSM meldet kein festes Tempolimit. Richtgeschwindigkeit und situationsangepasstes Fahren bleiben unberührt.';
  } else {
    els.delta.textContent = `${delta} km/h`;
    if (penaltyView.range && penaltyView.range.urban.fine !== penaltyView.range.rural.fine) {
      const low = Math.min(penaltyView.range.urban.fine, penaltyView.range.rural.fine);
      const high = Math.max(penaltyView.range.urban.fine, penaltyView.range.rural.fine);
      els.fine.textContent = `${low}–${high} €`;
      els.points.textContent = String(Math.max(penaltyView.range.urban.points, penaltyView.range.rural.points));
      els.ban.textContent = Math.max(penaltyView.range.urban.ban, penaltyView.range.rural.ban) > 0
        ? `bis ${Math.max(penaltyView.range.urban.ban, penaltyView.range.rural.ban)} Mon.`
        : 'Nein';
      els.fineNote.textContent = 'Innerorts/Außerorts nicht sicher erkannt; deshalb wird die mögliche Spanne gezeigt. Ohne Messtoleranz.';
    } else {
      els.fine.textContent = `${penalty.fine} €`;
      els.points.textContent = String(penalty.points);
      els.ban.textContent = penalty.ban ? `${penalty.ban} Mon.` : 'Nein';
      els.fineNote.textContent = 'Berechnung ohne Messtoleranz; Regelfall ohne Wiederholungstäter-Regel.';
    }
  }

  maybeAlert(delta);
}

els.startBtn.addEventListener('click', startTracking);
els.stopBtn.addEventListener('click', stopTracking);
els.soundToggle.addEventListener('change', () => {
  if (els.soundToggle.checked) {
    ensureAudioContext();
    beep(660, 0.08);
  }
});
els.quickLimits.addEventListener('click', event => {
  const button = event.target.closest('button[data-limit]');
  if (button) setOverride(button.dataset.limit);
});
els.clearOverrideBtn.addEventListener('click', () => clearOverride(true));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.watchId !== null && !state.wakeLock) requestWakeLock();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(registration => registration.update()).catch(error => console.info('Service Worker nicht aktiv', error));
  });
}

render();
