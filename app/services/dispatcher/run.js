const signal = require('../signal')
const { sdMessageOf, messageTypes } = signal
const channelRepository = require('./../../db/repositories/channel')
const membershipRepository = require('../../db/repositories/membership')
const { memberTypes } = membershipRepository
const executor = require('./commands')
const messenger = require('./messenger')
const resend = require('./resend')
const logger = require('./logger')
const safetyNumberService = require('../registrar/safetyNumbers')
const { messagesIn } = require('./strings/messages')
const { get, isEmpty, isNumber } = require('lodash')
const {
  signal: { signupPhoneNumber },
} = require('../../config')

/**
 * type Dispatchable = {
 *   db: SequelizeDatabaseConnection,
 *   sock: Socket,
 *   channel: models.Channel,
 *   sender: Sender,
 *   sdMessage: signal.OutBoundSignaldMessage,,
 * }
 *
 *  type UpdatableFingerprint = {
 *   channelPhoneNumber: string,
 *   memberPhoneNumber: string,
 *   fingerprint: string,
 *   sdMessage: SdMessage,
 * }
 *
 * type Sender = {
 *   phoneNumber: string,
 *   type: 'ADMIN', 'SUBSCRIBER', 'NONE',
 *   language: 'EN', 'ES',
 * }
 *
 * type CommandResult = {
 *   status: string,
 *   command: string,
 *   message: string,
 * }
 *
 * type SignalBoostStatus = {
 *   status: 'SUCCESS' | 'ERROR',
 *   message; string
 * }
 */

/******************
 *INITIALIZATION
 *****************/

const run = async (db, sock) => {
  logger.log('--- Initializing Dispatcher....')

  // for debugging...
  // sock.on('data', data => console.log(`+++++++++\n${data}\n++++++++\n`))

  logger.log(`----- Subscribing to channels...`)
  const channels = await channelRepository.findAllDeep(db).catch(logger.fatalError)
  const listening = await listenForInboundMessages(db, sock, channels).catch(logger.fatalError)
  logger.log(`----- Subscribed to ${listening.length} of ${channels.length} channels!`)

  logger.log(`--- Dispatcher running!`)
}

const listenForInboundMessages = async (db, sock, channels) => {
  const resendQueue = {}
  const numListening = await Promise.all(channels.map(ch => signal.subscribe(sock, ch.phoneNumber)))
  sock.on('data', inboundMsg =>
    dispatch(db, sock, resendQueue, parseMessage(inboundMsg)).catch(logger.error),
  )
  return numListening
}

/********************
 * MESSAGE DISPATCH
 *******************/

const dispatch = async (db, sock, resendQueue, inboundMsg) => {
  // retrieve db info we need for dispatching...
  const [channel, sender] = _isMessage(inboundMsg)
    ? await Promise.all([
        channelRepository.findDeep(db, inboundMsg.data.username),
        classifyPhoneNumber(db, inboundMsg.data.username, inboundMsg.data.source),
      ])
    : []

  // dispatch system-created messages
  const rateLimitedMessage = detectRateLimitedMessage(inboundMsg, resendQueue)
  if (rateLimitedMessage) {
    const resendInterval = resend.enqueueResend(sock, resendQueue, rateLimitedMessage)
    return notifyRateLimitedMessage(db, sock, rateLimitedMessage, resendInterval)
  }

  const newFingerprint = detectUpdatableFingerprint(inboundMsg)
  if (newFingerprint) return updateFingerprint(db, sock, newFingerprint)

  const newExpiryTime = detectUpdatableExpiryTime(inboundMsg, channel)
  if (isNumber(newExpiryTime)) return updateExpiryTime(db, sock, sender, channel, newExpiryTime)

  // dispatch user-created messages
  if (shouldRelay(inboundMsg)) return relay(db, sock, channel, sender, inboundMsg)
}

const relay = async (db, sock, channel, sender, inboundMsg) => {
  const sdMessage = signal.parseOutboundSdMessage(inboundMsg)
  try {
    const dispatchable = { db, sock, channel, sender, sdMessage }
    const commandResult = await executor.processCommand(dispatchable)
    return messenger.dispatch({ dispatchable, commandResult })
  } catch (e) {
    logger.error(e)
  }
}

const notifyRateLimitedMessage = async (db, sock, sdMessage, resendInterval) => {
  // const recipients = channelRepository.getAdminMemberships(
  //   await channelRepository.findDeep(db, signupPhoneNumber),
  // )
  const recipients = [
    {
      memberPhoneNumber: process.env.DEV_PHONE_NUMBER,
      language: 'EN',
    },
  ]
  return Promise.all(
    recipients.map(({ memberPhoneNumber, language }) =>
      signal.sendMessage(
        sock,
        memberPhoneNumber,
        sdMessageOf(
          { phoneNumber: signupPhoneNumber },
          messagesIn(language).notifications.rateLimitOccurred(
            sdMessage.username,
            sdMessage.recipientNumber,
            resendInterval,
          ),
        ),
      ),
    ),
  )
}

const updateFingerprint = async (db, sock, updatableFingerprint) => {
  const { channelPhoneNumber, memberPhoneNumber } = updatableFingerprint
  try {
    const recipient = await classifyPhoneNumber(db, channelPhoneNumber, memberPhoneNumber)
    if (recipient.type === memberTypes.NONE) return Promise.resolve()
    if (recipient.type === memberTypes.ADMIN) {
      return safetyNumberService
        .deauthorize(db, sock, updatableFingerprint)
        .then(logger.logAndReturn)
        .catch(logger.error)
    }
    return safetyNumberService
      .trustAndResend(db, sock, updatableFingerprint)
      .then(logger.logAndReturn)
      .catch(logger.error)
  } catch (e) {
    return logger.error(e)
  }
}

// (Database, Socket, Channel, number) -> Promise<void>
const updateExpiryTime = async (db, sock, sender, channel, messageExpiryTime) => {
  switch (sender.type) {
    case memberTypes.NONE:
      return Promise.resolve()
    case memberTypes.SUBSCRIBER:
      // override a disappearing message time set by a subscriber or rando
      return signal.setExpiration(
        sock,
        channel.phoneNumber,
        sender.phoneNumber,
        channel.messageExpiryTime,
      )
    case memberTypes.ADMIN:
      // enforce a disappearing message time set by an admin
      await channelRepository.update(db, channel.phoneNumber, { messageExpiryTime })
      return Promise.all(
        channel.memberships
          .filter(m => m.memberPhoneNumber !== sender.phoneNumber)
          .map(m =>
            signal.setExpiration(sock, channel.phoneNumber, m.memberPhoneNumber, messageExpiryTime),
          ),
      )
  }
}

/******************
 * MESSAGE PARSING
 ******************/

const parseMessage = inboundMsg => {
  try {
    return JSON.parse(inboundMsg)
  } catch (e) {
    return inboundMsg
  }
}

const shouldRelay = inboundMsg => _isMessage(inboundMsg) && !_isEmpty(inboundMsg)

const _isMessage = inboundMsg =>
  inboundMsg.type === signal.messageTypes.MESSAGE && get(inboundMsg, 'data.dataMessage')

const _isEmpty = inboundMsg =>
  get(inboundMsg, 'data.dataMessage.message') === '' &&
  isEmpty(get(inboundMsg, 'data.dataMessage.attachments'))

// InboundSdMessage -> SdMessage?
const detectRateLimitedMessage = inboundMsg =>
  inboundMsg.type === signal.messageTypes.ERROR &&
  (get(inboundMsg, 'data.message', '').includes('413') ||
    get(inboundMsg, 'data.message', '').includes('Rate limit'))
    ? inboundMsg.data.request
    : null

// SdMessage ->  UpdateableFingerprint?
const detectUpdatableFingerprint = inboundMsg => {
  if (inboundMsg.type === messageTypes.UNTRUSTED_IDENTITY) {
    // indicates a failed outbound message (from channel to recipient with new safety number)
    return {
      channelPhoneNumber: inboundMsg.data.username,
      memberPhoneNumber: inboundMsg.data.number,
      fingerprint: inboundMsg.data.fingerprint,
      sdMessage: inboundMsg.data.request,
    }
  }
  /**
   * TODO(aguestuser|2019-12-28):
   *  handle failed incoming messages here once an upstream issue around preserving fingerprints
   *  from exceptions of type `UntrustedIdentityException` is resolved:
   *  https://gitlab.com/thefinn93/signald/issues/4#note_265584999
   *  (atm: signald returns a not very useful `'type': 'unreadable_message'` message)
   **/
  return null
}

// (SdMessage, Channel) -> UpdatableExpiryTime?
const detectUpdatableExpiryTime = (inboundMsg, channel) =>
  _isMessage(inboundMsg) &&
  inboundMsg.data.dataMessage.expiresInSeconds !== channel.messageExpiryTime
    ? inboundMsg.data.dataMessage.expiresInSeconds
    : null

const classifyPhoneNumber = async (db, channelPhoneNumber, senderPhoneNumber) => {
  // TODO(aguestuser|2019-12-02): do this with one db query!
  const type = await membershipRepository.resolveSenderType(
    db,
    channelPhoneNumber,
    senderPhoneNumber,
  )
  const language = await membershipRepository.resolveSenderLanguage(
    db,
    channelPhoneNumber,
    senderPhoneNumber,
    type,
  )
  return { phoneNumber: senderPhoneNumber, type, language }
}

// EXPORTS

module.exports = { run }
