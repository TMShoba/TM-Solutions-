// Vercel serverless function: every /api/* request lands here.
const { handle } = require('../lib/core');

module.exports = (req, res) => handle(req, res);
