const statuses = {
  NOOP: 'NOOP',
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
}

const vouchModes = {
  ON: 'ON',
  OFF: 'OFF',
  ADMIN: 'ADMIN',
}

const toggles = {
  HOTLINE: { dbField: 'hotlineOn', name: 'hotline' },
}

const commands = {
  ADD: 'ADD',
  ACCEPT: 'ACCEPT',
  DECLINE: 'DECLINE',
  DESTROY: 'DESTROY',
  DESTROY_CONFIRM: 'DESTROY_CONFIRM',
  HELP: 'HELP',
  HOTLINE_OFF: 'HOTLINE_OFF',
  HOTLINE_ON: 'HOTLINE_ON',
  INFO: 'INFO',
  INVITE: 'INVITE',
  JOIN: 'JOIN',
  LEAVE: 'LEAVE',
  NOOP: 'NOOP',
  PRIVATE: 'PRIVATE',
  REMOVE: 'REMOVE',
  RENAME: 'RENAME',
  REPLY: 'REPLY',
  SET_DESCRIPTION: 'SET_DESCRIPTION',
  SET_LANGUAGE: 'SET_LANGUAGE',
  VOUCH_LEVEL: 'VOUCH_LEVEL',
  VOUCHING_ON: 'VOUCHING_ON',
  VOUCHING_OFF: 'VOUCHING_OFF',
  VOUCHING_ADMIN: 'VOUCHING_ADMIN',
}

module.exports = { statuses, toggles, commands, vouchModes }