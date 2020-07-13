const socketWriter = require('../socket/write')
const channelRepository = require('../db/repositories/channel')
const callbacks = require('./callbacks')
const { pick, isEmpty } = require('lodash')
const { messages, messageTypes, trustLevels } = require('./constants')
const util = require('../util')
const { statuses, loggerOf } = util

/**
 *
 * type Address = {
 *   number: ?string,
 *   uuid: ?string,
 * }
 *
 * type InboundSignaldMessage = {
 *   type: "message",
 *   data: {
 *     username: string,
 *     source: Address,
 *     sourceDevice: number,
 *     type: string,
 *     dataMessage: ?{
 *       timestamp: number,
 *       body: string,
 *       expiresInSeconds: number,
 *       endSession: bool,
 *       profileKeyUpdate: bool,
 *       attachments: Array<InAttachment>?,
 *     }
 *   }
 * }
 *
 * type InboundAttachment = {
 *   contentType: string,
 *   id: number,
 *   size: number,
 *   storedFilename: string,
 *   width: number,
 *   height: number,
 *   voiceNote: boolean,
 *   preview: { present: boolean },
 *   key: string, (base64)
 *   digest: string, (base64)
 * }
 *
 * type ResendRequest = {
 *   type: "send",
 *   username: string,
 *   recipientAddress, ?Address, (must include either recipientId or recipientGroupId)
 *   messageBody: string,
 *   attachments: Array<InAttachment>,
 *   quote: ?QuoteObject, (ingoring)
 * }
 *
 * type OutboundSignaldMessage = {
 *   type: "send",
 *   username: string,
 *   recipientNumber, ?string, (must include either recipientId or recipientGroupId)
 *   recipientGroupId: ?string,
 *   messageBody: string,
 *   attachments: Array<OutAttachment>,
 *   quote: ?QuoteObject, (ingoring)
 * }
 *
 * type OutboundAttachment = {
 *   filename: string (The filename of the attachment) == `storedFilename`
 *   caption: string (An optional caption) == ../../dataMessage.message
 *   width: int (The width of the image) == width
 *   height: int (The height of the image) == height
 *   voiceNote: bool (True if this attachment is a voice note) == voiceNote
 *   preview: string (The preview data to send, base64 encoded) == preview
 * }
 *
 * type SignalIdentity -= {
 *   trust_level: "TRUSTED" | "TRUSTED_UNVERIFIED" | "UNTRUSTED"
 *   added: string, // millis from epoc
 *   fingerprint: string // 32 space-separated 32 hex octets
 *   safety_number: string, // 60 digit number
 *   username: string, // valid phone number
 * }
 *
 * */

const logger = loggerOf('signal')

/**********************
 * STARTUP
 **********************/

const run = async () => {
  logger.log(`--- Subscribing to channels...`)
  const channels = await channelRepository.findAllDeep().catch(logger.fatalError)
  const numListening = await Promise.all(channels.map(ch => subscribe(ch.phoneNumber)))
  logger.log(`--- Subscribed to ${numListening.length} / ${channels.length} channels!`)
}

/********************
 * SIGNALD COMMANDS
 ********************/

// string -> Promise<SignalboostStatus>
const register = async phoneNumber => {
  socketWriter.write({ type: messageTypes.REGISTER, username: phoneNumber })
  // Since a registration isn't meaningful without a verification code,
  // we resolve `register` by invoking the callback handler fo the response to the VERIFY request
  // that will be issued to signald after twilio callback (POST /twilioSms) triggers `verify` below
  return new Promise((resolve, reject) =>
    callbacks.register({
      messageType: messageTypes.VERIFY,
      id: phoneNumber,
      resolve,
      reject,
    }),
  )
}

// (string, string) -> Promise<SignalboostStatus>
const verify = (phoneNumber, code) =>
  // This function is only called from twilio callback as fire-and-forget.
  // Its response will be picked up by the callback for the REGISTER command that triggered it.
  // Therefore, all we need to do with this response is signal to twilio whether socketWriter socketWriter.write worked.
  socketWriter
    .write({ type: messageTypes.VERIFY, username: phoneNumber, code })
    .then(() => ({ status: statuses.SUCCESS, message: 'OK' }))
    .catch(e => ({ status: statuses.ERROR, message: e.message }))

// string -> Promise<string>
const subscribe = phoneNumber =>
  socketWriter.write({ type: messageTypes.SUBSCRIBE, username: phoneNumber })

// string -> Promise<string>
const unsubscribe = phoneNumber =>
  socketWriter.write({ type: messageTypes.UNSUBSCRIBE, username: phoneNumber })

// (string, OutboundSignaldMessage) -> Promise<string>
const sendMessage = async (recipientNumber, sdMessage) => {
  const recipientAddress = { number: recipientNumber }
  const id = await socketWriter.write({ ...sdMessage, recipientAddress })
  callbacks.register({
    id,
    messageType: messageTypes.SEND,
    state: {
      channelPhoneNumber: sdMessage.username,
      messageBody: sdMessage.messageBody,
      attachments: sdMessage.attachments,
      whenSent: util.nowInMillis(),
    },
  })
  return id
}

// (Array<string>, OutboundSignaldMessage) -> Promise<Array<string>>
const broadcastMessage = (recipientNumbers, outboundMessage) =>
  Promise.all(
    recipientNumbers.map(recipientNumber => sendMessage(recipientNumber, outboundMessage)),
  )

const setExpiration = (channelPhoneNumber, memberPhoneNumber, expiresInSeconds) =>
  socketWriter.write({
    type: messageTypes.SET_EXPIRATION,
    username: channelPhoneNumber,
    recipientAddress: { number: memberPhoneNumber },
    expiresInSeconds,
  })

// (String, String, String?) -> Promise<SignalboostStatus>
const trust = async (channelPhoneNumber, memberPhoneNumber, fingerprint) => {
  const id = await socketWriter.write({
    type: messageTypes.TRUST,
    username: channelPhoneNumber,
    recipientAddress: { number: memberPhoneNumber },
    fingerprint,
  })
  return new Promise((resolve, reject) => {
    callbacks.register({ messageType: messageTypes.TRUST, id, resolve, reject })
  })
}

/*******************
 * MESSAGE PARSING
 *******************/

// InboundMessage|ResendRequest -> OutboundMessage
const parseOutboundSdMessage = inboundSdMessage => {
  const {
    recipientAddress,
    data: { username, dataMessage },
  } = transformToInboundMessage(inboundSdMessage)
  return {
    type: messageTypes.SEND,
    username,
    recipientAddress,
    messageBody: dataMessage.body || '',
    attachments: (dataMessage.attachments || []).map(parseOutboundAttachment),
  }
}

// InboundMessage|ResendRequest -> InboundMessage
const transformToInboundMessage = message => {
  const { type } = message
  if (type === 'message') {
    return message
  } else {
    return {
      recipientAddress: message.recipientAddress,
      data: {
        username: message.username,
        dataMessage: { body: message.messageBody, attachments: message.attachments },
      },
    }
  }
}

// SignaldInboundAttachment -> SignaldOutboundAttachment
const parseOutboundAttachment = inAttachment => ({
  filename: inAttachment.storedFilename || inAttachment.filename || '',
  ...pick(inAttachment, ['caption', 'width', 'height', 'voiceNote']),
})

// string -> [boolean, string]
const parseVerificationCode = verificationMessage => {
  const matches = verificationMessage.match(/Your Signal verification code: (\d\d\d-\d\d\d)/)
  return isEmpty(matches) ? [false, verificationMessage] : [true, matches[1]]
}

module.exports = {
  messages,
  messageTypes,
  trustLevels,
  broadcastMessage,
  parseOutboundSdMessage,
  parseOutboundAttachment,
  parseVerificationCode,
  register,
  run,
  sendMessage,
  subscribe,
  trust,
  verify,
  setExpiration,
  unsubscribe,
}
