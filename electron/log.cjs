// Small rotating diagnostics log (userData/logs/wicked.log) to investigate freezes and slow runs.
const fs = require('fs')
const path = require('path')

let file = null
const MAX = 2 * 1024 * 1024

function initLog(dir) {
  fs.mkdirSync(dir, { recursive: true })
  file = path.join(dir, 'wicked.log')
  try {
    if (fs.statSync(file).size > MAX) fs.renameSync(file, file + '.1')
  } catch {
    /* no log yet */
  }
  log('app', 'started')
  return file
}

function log(area, msg, data) {
  if (!file) return
  const line = `${new Date().toISOString()} [${area}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}\n`
  fs.appendFile(file, line, () => {})
}

module.exports = { initLog, log, logFile: () => file }
