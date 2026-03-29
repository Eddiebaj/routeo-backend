// api/ebevents.js  — Vercel serverless route
// NOTE: Eventbrite deprecated their public /v3/events/search/ API in 2024.
// This endpoint now returns an empty array gracefully.
// Events are served via Ticketmaster on the frontend.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600');
  res.json({ events: [], note: 'Eventbrite search API deprecated — use Ticketmaster' });
}
