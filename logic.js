export const BUKAT_SOURCE_DATE = '2026-09-09';

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

export function parseNumericSpeed(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  if (text === 'none' || text === 'unlimited') return {kind:'unlimited', value:null, raw:value};
  if (text === 'walk') return {kind:'numeric', value:7, raw:value};
  if (text === 'signals' || text === 'variable') return {kind:'unknown', value:null, raw:value};

  const mphValues = [...text.matchAll(/(\d+(?:\.\d+)?)\s*mph/g)]
    .map(match => Math.round(Number(match[1]) * 1.609344));
  if (mphValues.length) return {kind:'numeric', value:Math.min(...mphValues), raw:value};

  const values = [...text.matchAll(/(?:^|[;|,\s])(\d{1,3})(?=$|[;|,\s])/g)]
    .map(match => Number(match[1]));
  if (values.length) return {kind:'numeric', value:Math.min(...values), raw:value};

  const single = text.match(/\d{1,3}/);
  if (single) return {kind:'numeric', value:Number(single[0]), raw:value};
  return null;
}

export function parseGermanDefault(value) {
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

export function parseSpeedValue(value) {
  return parseGermanDefault(value) || parseNumericSpeed(value);
}

export function parseTimeRangeCondition(condition, now = new Date()) {
  const normalized = condition.replace(/[()]/g, ' ').trim();
  if (/wet|snow|ice|school|weight|sunrise|sunset|holiday|ph|sh/i.test(normalized)) return null;

  const dayMatch = normalized.match(/\b(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?\b/i);
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

export function evaluateConditionalSpeed(value, now = new Date()) {
  if (!value) return {active:null, note:null};
  const parts = String(value).split(/;(?=\s*(?:\d|none|walk))/);
  for (const part of parts) {
    const match = part.match(/^\s*([^@]+?)\s*@\s*\((.+)\)\s*$/);
    if (!match) continue;
    const parsed = parseSpeedValue(match[1]);
    const conditionResult = parseTimeRangeCondition(match[2], now);
    if (parsed && conditionResult === true) {
      return {active:parsed, note:`Zeitabhängiges OSM-Limit aktiv: ${part.trim()}`};
    }
    if (conditionResult == null) {
      return {active:null, note:`Bedingtes OSM-Limit vorhanden (${part.trim()}). Zusatzschild prüfen.`};
    }
  }
  return {active:null, note:`Bedingtes OSM-Limit vorhanden (${value}). Zusatzschild prüfen.`};
}

export function calculateFine(delta, area) {
  if (delta <= 0) return {fine:0, points:0, ban:0, areaUsed:area};
  const areaUsed = area === 'urban' ? 'urban' : 'rural';
  const row = fineTable[areaUsed].find(entry => delta <= entry.max);
  return {...row, areaUsed};
}

export function calculatePenaltyView(delta, area) {
  if (area !== 'unknown') return {primary:calculateFine(delta, area), range:null};
  const urban = calculateFine(delta, 'urban');
  const rural = calculateFine(delta, 'rural');
  return {
    primary:urban.fine >= rural.fine ? urban : rural,
    range:{urban, rural}
  };
}
