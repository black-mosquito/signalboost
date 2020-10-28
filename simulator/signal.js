const socketWriter = require('./socket/write')
const callbacks = require('./callbacks')
const { pick, isEmpty } = require('lodash')
const fetch = require("node-fetch")
const { messages, messageTypes, trustLevels } = require('../app/signal/constants')
const util = require('../app/util')
const { statuses, loggerOf } = util
const {
  signal: { diagnosticsPhoneNumber, broadcastSpacing },
} = require('../app/config')

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
 *   recipientAddress, ?Address, (must include either recipientId or recipientGroupId)
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

const run = async (botPhoneNumbers) => {
  logger.log(`--- Creating bot phoneNumbers...`)
  try {
    await Promise.all(botPhoneNumbers.map(register))
    logger.log(`--- Created boot phoneNumbers!`)
    await Promise.all(botPhoneNumbers.map(subscribe))
    logger.log(`--- Subscribed bot phoneNumbers!`)
    return
  } catch (e) {
    logger.log(`--- Error creating bot phoneNumbers...  `)
    logger.error(e)
  }
}

/********************
 * SIGNALD COMMANDS
 ********************/

// (string, string || null) -> Promise<SignalboostStatus>
const register = async (phoneNumber, captchaToken) => {
  socketWriter.write({
    type: messageTypes.REGISTER,
    username: phoneNumber,
    ...(captchaToken ? { captcha: captchaToken } : {}),
  })

  await util.wait(3000)
  await verify(phoneNumber)

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
const verify = async (phoneNumber) => {

  const params = new URLSearchParams()
  params.append('number', phoneNumber)

  const code = await fetch("http://signal_sms_codes:8082/helper/verification-code", {
    method: 'POST',
    body: params
  }).then(response => response.json())

  logger.log("VERIFY CODE: " + code)

  return socketWriter
    .write({ type: messageTypes.VERIFY, username: phoneNumber, code })
    .then(() => ({ status: statuses.SUCCESS, message: 'OK' }))
    .catch(e => ({ status: statuses.ERROR, message: e.message }))
}

// string -> Promise<string>
const subscribe = phoneNumber =>
  socketWriter.write({ type: messageTypes.SUBSCRIBE, username: phoneNumber })

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

// string -> [boolean, string]
const parseVerificationCode = verificationMessage => {
  const matches = verificationMessage.match(/.*: (\d\d\d-\d\d\d)/)
  return isEmpty(matches) ? [false, verificationMessage] : [true, matches[1]]
}

module.exports = {
  messages,
  messageTypes,
  parseVerificationCode,
  register,
  run,
  sendMessage,
  subscribe,
  verify,
}