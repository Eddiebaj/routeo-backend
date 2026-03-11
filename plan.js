export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { fromPlace, toPlace, mode, date, time, numItineraries } = req.query;

  const OTP_URL = 'https://routeo-otp-production.up.railway.app';

  const params = new URLSearchParams({
    fromPlace,
    toPlace,
    mode: mode || 'TRANSIT,WALK',
    date: date || new Date().toISOString().split('T')[0],
    time: time || '08:00am',
    numItineraries: numItineraries || '5',
  });

  try {
    const response = await fetch(`${OTP_URL}/otp/routers/default/plan?${params}`);
    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: 'OTP request failed', details: err.message });
  }
}
