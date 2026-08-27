'use strict';

const fs = require('node:fs');
const path = require('node:path');

const matrixPath = path.join(__dirname, 'data', 'engine-matrix.json');
const upstreamStatusPath = path.join(__dirname, 'data', 'upstream-status.json');

function load() {
  return JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
}

const file = load();

module.exports = {
  matrixPath,
  upstreamStatusPath,
  entries: file.entries,
  matrixVersion: file.matrixVersion,
  updated: file.updated,
};