const AdmZip = require('adm-zip');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const GTFS_ZIP = 'https://oct-gtfs-emasagcnfmcgeham.z01.azurefd.net/public-access/GTFSExport.zip';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const resp = await fetch(GTFS_ZIP);
    const buffer = await resp.arrayBuffer();
    const zip = new AdmZip(Buffer.from(buffer));
    const text = zip.readAsText('stops.txt');
    const lines = text.trim().split('\n').slice(0, 10);
    res.json({ sample: lines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};