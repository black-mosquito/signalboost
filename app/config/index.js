// TODO: elminate call to 'dotenv' once tests are dockerized...
require('dotenv').config()
const { get } = require('lodash')
const dbConfigsByEnv = require('./db.json')
const twilioConfigsByEnv = require('./twilio')
const registrarConfigsByEnv = require('./registrar')
const signalConfigsByEnv = require('./signal')
const { languages } = require('../constants')

const getConfig = cfg => get(cfg, [process.env.NODE_ENV || 'production'])

module.exports = {
  projectRoot: process.env.PROJECT_ROOT,
  defaultLanguage: process.env.DEFAULT_LANGUAGE || languages.EN,
  db: getConfig(dbConfigsByEnv),
  twilio: getConfig(twilioConfigsByEnv),
  registrar: getConfig(registrarConfigsByEnv),
  signal: getConfig(signalConfigsByEnv),
}
