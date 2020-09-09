const signal = require('../signal')
const channelRepository = require('../db/repositories/channel')
const messageCountRepository = require('../db/repositories/messageCount')
const hotlineMessageRepository = require('../db/repositories/hotlineMessage')
const { messagesIn } = require('./strings/messages')
const { sdMessageOf } = require('../signal/constants')
const { memberTypes } = require('../db/repositories/membership')
const { values, isEmpty } = require('lodash')
const { commands } = require('./commands/constants')
const { statuses } = require('../util')
const { wait, sequence, batchesOfN } = require('../util')
const { loggerOf } = require('../util')
const logger = loggerOf('messenger')
const metrics = require('../metrics')
const { counters } = metrics
const {
  signal: { setExpiryInterval, broadcastBatchSize, broadcastBatchInterval },
} = require('../config')

/**
 * type MessageType = 'BROADCAST_MESSAGE' | 'HOTLINE_MESSAGE' | 'COMMAND' | 'PRIVATE MESSAGE' | 'NOOP'
 */

const messageTypes = {
  BROADCAST_MESSAGE: 'BROADCAST_MESSAGE',
  HOTLINE_MESSAGE: 'HOTLINE_MESSAGE',
  COMMAND: 'COMMAND',
  PRIVATE_MESSAGE: 'PRIVATE_MESSAGE',
  NOOP: 'NOOP',
}

const { BROADCAST_MESSAGE, HOTLINE_MESSAGE, COMMAND, PRIVATE_MESSAGE, NOOP } = messageTypes

const { ADMIN } = memberTypes

/***************
 * DISPATCHING
 ***************/

// (CommandResult, Dispatchable) -> Promise<void>
const dispatch = async ({ commandResult, dispatchable }) => {
  const messageType = parseMessageType(commandResult, dispatchable)
  const channelPhoneNumber = dispatchable.channel.phoneNumber
  const { message } = commandResult

  switch (messageType) {
    case BROADCAST_MESSAGE:
      metrics.incrementCounter(counters.SIGNALBOOST_MESSAGES, [
        channelPhoneNumber,
        BROADCAST_MESSAGE,
        null,
      ])
      return broadcast(message, dispatchable)
    case HOTLINE_MESSAGE:
      metrics.incrementCounter(counters.SIGNALBOOST_MESSAGES, [
        channelPhoneNumber,
        HOTLINE_MESSAGE,
        null,
      ])
      return handleHotlineMessage(dispatchable)
    case COMMAND:
      metrics.incrementCounter(counters.SIGNALBOOST_MESSAGES, [
        channelPhoneNumber,
        COMMAND,
        commandResult.command,
      ])
      return handleCommandResult({ commandResult, dispatchable })
    case NOOP:
      return handleCommandResult({ commandResult, dispatchable })
    default:
      return Promise.reject(`Invalid message. Must be one of: ${values(messageTypes)}`)
  }
}

// (CommandResult, Dispatchable) -> MessageType
const parseMessageType = (commandResult, { sender }) => {
  if (commandResult.status === NOOP) {
    return sender.type === ADMIN ? NOOP : HOTLINE_MESSAGE
  }

  if (commandResult.command === commands.BROADCAST && sender.type === ADMIN)
    return BROADCAST_MESSAGE

  return COMMAND
}

const handleHotlineMessage = dispatchable => {
  const {
    channel: { hotlineOn },
    sender: { language, type },
  } = dispatchable
  const disabledMessage = messagesIn(language).notifications.hotlineMessagesDisabled(
    type === memberTypes.SUBSCRIBER,
  )
  return hotlineOn
    ? relayHotlineMessage(dispatchable)
    : respond({ ...dispatchable, status: statuses.UNAUTHORIZED, message: disabledMessage })
}

const handleCommandResult = async ({ commandResult, dispatchable }) => {
  const { command, message, status } = commandResult
  await respond({ ...dispatchable, message, command, status })
  await sendNotifications({ commandResult, dispatchable })
  await wait(setExpiryInterval) // to ensure welcome notification arrives first
  await setExpiryTimeForNewUsers({ commandResult, dispatchable })
  return Promise.resolve()
}

/************
 * SENDING
 ************/

// Dispatchable -> Promise<MessageCount>
const broadcast = async (message, { channel, sdMessage }) => {
  const recipients = channel.memberships

  try {
    if (isEmpty(sdMessage.attachments)) {
      await sequence(
        recipients.map(recipient => () =>
          signal.sendMessage(
            recipient.memberPhoneNumber,
            addHeader({
              channel,
              sdMessage,
              messageType: BROADCAST_MESSAGE,
              language: recipient.language,
              memberType: recipient.type,
            }),
          ),
        ),
      )
    } else {
      const recipientBatches = batchesOfN(recipients, broadcastBatchSize)
      await sequence(
        recipientBatches.map(recipientBatch => {
          recipientBatch.map(recipient => {
            signal.broadcastMessage([recipient.memberPhoneNumber], {
              ...sdMessage,
              messageBody: message,
            })
          })
        }),
        broadcastBatchInterval,
      )
    }
    return messageCountRepository.countBroadcast(channel)
  } catch (e) {
    logger.error(e)
  }
}

// Dispatchable -> Promise<void>
const relayHotlineMessage = async ({ channel, sender, sdMessage }) => {
  const { language } = sender
  const recipients = channelRepository.getAdminMemberships(channel)
  const response = messagesIn(language).notifications.hotlineMessageSent(channel)

  const messageId = await hotlineMessageRepository.getMessageId({
    channelPhoneNumber: channel.phoneNumber,
    memberPhoneNumber: sender.phoneNumber,
  })

  await Promise.all(
    recipients.map(recipient =>
      signal.sendMessage(
        recipient.memberPhoneNumber,
        addHeader({
          channel,
          sdMessage,
          messageType: HOTLINE_MESSAGE,
          language: recipient.language,
          messageId,
        }),
      ),
    ),
  )

  return signal
    .sendMessage(sender.phoneNumber, sdMessageOf(channel, response))
    .then(() => messageCountRepository.countHotline(channel))
}

// (Database, Socket, Channel, string, Sender) -> Promise<void>
const respond = ({ channel, message, sender, command, status }) => {
  // FIX: PRIVATE command sends out all messages including to sender
  // because respond doesn't handle attachments, don't want to repeat message here
  if (command === commands.PRIVATE && status === statuses.SUCCESS) return
  return signal.sendMessage(sender.phoneNumber, sdMessageOf(channel, message)).then(async () => {
    // Don't count INFO commands from sysadmins. Why?
    // Sysadmins ping channels with INFO as an informal health checks very frequently.
    // Counting these pings would prevent us from detecting stale channels for recycling, which
    // we currently accomplish by looking for old timestamps in `channel.messageCounts.updatedAt`.
    const shouldCount = !(
      command === commands.INFO && (await channelRepository.isSysadmin(sender.phoneNumber))
    )
    return shouldCount && messageCountRepository.countCommand(channel)
  })
}

// ({ CommandResult, Dispatchable )) -> Promise<SignalboostStatus>
const sendNotifications = ({ commandResult, dispatchable }) => {
  const { channel } = dispatchable
  const { status, notifications } = commandResult

  return status === statuses.SUCCESS
    ? Promise.all(notifications.map(notification => notify({ channel, notification })))
    : Promise.resolve([])
}

// ({Socket, Channel, Notification}) -> Promise<void>
const notify = ({ channel, notification }) =>
  signal.sendMessage(notification.recipient, sdMessageOf(channel, notification.message))

// ({ CommandResult, Dispatchable }) -> Promise<void>
const setExpiryTimeForNewUsers = async ({ commandResult, dispatchable }) => {
  // for newly added users, make sure disappearing message timer
  // is set to channel's default expiry time
  const { command, payload, status } = commandResult
  const { channel, sender } = dispatchable

  if (status !== statuses.SUCCESS) return Promise.resolve()

  switch (command) {
    case commands.ADD:
      // in ADD case, payload is an e164 phone number
      // must be e164, else parse step would have failed and cmd could not have executed successfully
      return signal.setExpiration(channel.phoneNumber, payload, channel.messageExpiryTime)
    case commands.INVITE:
      // in INVITE case, payload is an array of e164 phone numbers (must be e164 for same reasons as ADD above)
      return Promise.all(
        payload.map(memberPhoneNumber =>
          signal.setExpiration(channel.phoneNumber, memberPhoneNumber, channel.messageExpiryTime),
        ),
      )
    case commands.JOIN:
    case commands.ACCEPT:
      return signal.setExpiration(
        channel.phoneNumber,
        sender.phoneNumber,
        channel.messageExpiryTime,
      )
    default:
      return Promise.resolve()
  }
}

/**********
 * HELPERS
 **********/

/* { Channel, string, string, string, string } -> OutboundSignaldMessage */
const addHeader = ({ channel, sdMessage, messageType, language, memberType, messageId }) => {
  let prefix
  if (messageType === HOTLINE_MESSAGE) {
    prefix = `[${messagesIn(language).prefixes.hotlineMessage(messageId)}]\n`
  } else if (messageType === BROADCAST_MESSAGE) {
    if (memberType === ADMIN) {
      prefix = `[${messagesIn(language).prefixes.broadcastMessage}]\n`
    } else {
      prefix = `[${channel.name}]\n`
    }
  } else if (messageType === PRIVATE_MESSAGE) {
    prefix = `[${messagesIn(language).prefixes.privateMessage}]\n`
  }

  return { ...sdMessage, messageBody: `${prefix}${sdMessage.messageBody}` }
}

module.exports = {
  messageTypes,
  /**********/
  broadcast,
  dispatch,
  addHeader,
  parseMessageType,
  respond,
  notify,
}
