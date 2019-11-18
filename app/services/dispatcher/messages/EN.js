const { upperCase } = require('lodash')

const systemName = 'the signalboost system administrator'
const unauthorized = 'Whoops! You are not authorized to do that on this channel.'
const invalidNumber = phoneNumber =>
  `Whoops! "${phoneNumber}" is not a valid phone number. Phone numbers must include country codes prefixed by a '+'.`

const support = `
----------------------------
HOW IT WORKS
----------------------------

-> Signalboost channels have broadcasters and subscribers.
-> Broadcasters send announcements that are broadcast to subscribers.
-> People can subscribe by sending HELLO or HOLA to this number.
-> Unsubscribe by sending GOODBYE or ADÍOS to this number.
-> Send HELP or AYUDA to list commands that make Signalboost do things.
-> Learn more: https://signalboost.info
`

const notifications = {
  publisherAdded: (commandIssuer, addedPublisher) =>
    `New broadcaster ${addedPublisher} added by ${commandIssuer}`,
  broadcastResponseSent: channel => `Your message was forwarded to the broadcasters of [${channel.name}]`,
  deauthorization: publisherPhoneNumber => `
${publisherPhoneNumber} has been removed from this channel because their safety number changed.

This is almost certainly because they reinstalled Signal on a new phone.

However, there is a small chance that an attacker has compromised their phone and is trying to impersonate them.

Check with ${publisherPhoneNumber} to make sure they still control their phone, then reauthorize them with:

ADD ${publisherPhoneNumber}

Until then, they will be unable to send messages to or read messages from this channel.`,
  noop: "Whoops! That's not a command!",
  unauthorized: "Whoops! I don't understand that.\n Send HELP to see commands I understand!",
  welcome: (addingPublisher, channelPhoneNumber) => `
You were just made a broadcaster of this Signalboost channel by ${addingPublisher}. Welcome!

People can subscribe to this channel by sending HELLO to ${channelPhoneNumber} and unsubscribe by sending GOODBYE.

Reply with HELP for more info.`,
  signupRequestReceived: (senderNumber, requestMsg) =>
    `Signup request received from ${senderNumber}:\n ${requestMsg}`,
  signupRequestResponse:
    'Thank you for signing up for Signalboost!\n You will receive a welcome message on your new channel shortly...',
}

const commandResponses = {
  // ADD/REMOVE PUBLISHER
  publisher: {
    add: {
      success: num => `${num} added as a broadcaster.`,
      unauthorized,
      dbError: num => `Whoops! There was an error adding ${num} as a broadcaster. Please try again!`,
      invalidNumber,
    },
    remove: {
      success: num => `${num} removed as a broadcaster.`,
      unauthorized,
      dbError: num => `Whoops! There was an error trying to remove ${num}. Please try again!`,
      invalidNumber,
      targetNotPublisher: num => `Whoops! ${num} is not a broadcaster. Can't remove them.`,
    },
  },
  // HELP
  help: {
    publisher: `[COMMANDS I UNDERSTAND:]

HELP / AYUDA
-> lists commands

INFO
-> shows stats, explains how signalboost works

RENAME new name
-> renames channel to "new name"

ADD +1-555-555-5555
-> makes +1-555-555-5555 a broadcaster

REMOVE +1-555-555-5555
-> removes +1-555-555-5555 as a broadcaster

RESPONSES ON
-> allows subscribers to send messages to broadcasters

RESPONSES OFF
-> disables subscribers from sending messages to broadcasters

GOODBYE / ADIOS
-> leaves this channel`,
    subscriber: `[COMMANDS I UNDERSTAND:]

HELP / AYUDA
-> lists commands

INFO
-> shows stats, explains how signalboost works

HELLO / HOLA
-> subscribes you to announcements

GOODBYE / ADIOS
-> unsubscribes you from announcements`,
  },

  // INFO
  info: {
    publisher: channel => `
---------------------------
CHANNEL INFO:
---------------------------

name: ${channel.name}
phone number: ${channel.phoneNumber}
subscribers: ${channel.subscriptions.length}
broadcasters: ${channel.publications.map(a => a.publisherPhoneNumber).join(', ')}
responses: ${channel.responsesEnabled ? 'ON' : 'OFF'}
messages sent: ${channel.messageCount.broadcastIn}
${support}`,
    subscriber: channel => `
---------------------------
CHANNEL INFO:
---------------------------

name: ${channel.name}
phone number: ${channel.phoneNumber}
responses: ${channel.responsesEnabled ? 'ON' : 'OFF'}
subscribers: ${channel.subscriptions.length}
broadcasters: ${channel.publications.length}
${support}`,
    unauthorized,
  },
  // RENAME
  rename: {
    success: (oldName, newName) =>
      `[${newName}]\nChannel renamed from "${oldName}" to "${newName}".`,
    dbError: (oldName, newName) =>
      `[${oldName}]\nWhoops! There was an error renaming the channel [${oldName}] to [${newName}]. Try again!`,
    unauthorized,
  },
  // JOIN/LEAVE
  subscriber: {
    add: {
      success: channel => {
        const { name } = channel
        return `
Welcome to Signalboost! You are now subscribed to the [${name}] channel.

Reply with HELP to learn more or GOODBYE to unsubscribe.`
      },
      dbError: `Whoops! There was an error adding you to the channel. Please try again!`,
      noop: `Whoops! You are already a member of the channel.`,
    },
    remove: {
      success: `You've been removed from the channel! Bye!`,
      error: `Whoops! There was an error removing you from the channel. Please try again!`,
      unauthorized,
    },
  },
  // TOGGLE RESPONSES
  toggleResponses: {
    success: setting => `Subscriber responses turned ${upperCase(setting)}.`,
    unauthorized,
    dbError: setting =>
      `Whoops! There was an error trying to set responses to ${setting}. Please try again!`,
    invalidSetting: setting =>
      `Whoops! ${setting} is not a valid setting. You can set responses to be either ON or OFF.`,
  },
  trust: {
    success: phoneNumber => `Updated safety number for ${phoneNumber}`,
    error: phoneNumber =>
      `Failed to update safety number for ${phoneNumber}. Try again or contact a maintainer!`,
    partialError: (phoneNumber, success, error) =>
      `Updated safety number for ${success} out of ${success +
        error} channels that ${phoneNumber} belongs to.`,
    invalidNumber,
    unauthorized,
    targetNotMember: phoneNumber =>
      `Whoops! ${phoneNumber} is not a broadcaster or subscriber on this channel. Cannot reactivate them.`,
    dbError: phoneNumber =>
      `Whoops! There was an error updating the safety number for ${phoneNumber}. Please try again!`,
  },
}

const prefixes = {
  broadcastResponse: `SUBSCRIBER RESPONSE:`,
}

const EN = {
  commandResponses,
  notifications,
  prefixes,
  systemName,
}

module.exports = EN
