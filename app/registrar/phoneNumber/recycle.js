const channelRepository = require('../../db/repositories/channel')
const phoneNumberRepository = require('../../db/repositories/phoneNumber')
const eventRepository = require('../../db/repositories/event')
const common = require('./common')
const { defaultLanguage } = require('../../config')
const signal = require('../../signal')
const { eventTypes } = require('../../db/models/event')
const { sdMessageOf } = require('../../signal/constants')
const { messagesIn } = require('../../dispatcher/strings/messages')

// ({Database, Socket, string}) -> SignalboostStatus
const recycle = async ({ phoneNumbers }) => {
  return await Promise.all(
    phoneNumbers.split(',').map(async phoneNumber => {
      const channel = await channelRepository.findDeep(phoneNumber)

      if (channel) {
        return notifyMembers(channel)
          .then(() => common.destroyChannel(channel))
          .then(() => eventRepository.log(eventTypes.CHANNEL_DESTROYED, phoneNumber))
          .then(() => recordStatusChange(phoneNumber, common.statuses.VERIFIED))
          .then(phoneNumberStatus => ({ status: 'SUCCESS', data: phoneNumberStatus }))
          .catch(err => handleRecycleFailure(err, phoneNumber))
      } else {
        return { status: 'ERROR', message: `Channel not found for ${phoneNumber}` }
      }
    }),
  )
}

/********************
 * HELPER FUNCTIONS
 ********************/
// (Database, Socket, Channel) -> Channel
const notifyMembers = async channel => {
  const memberPhoneNumbers = channelRepository.getMemberPhoneNumbers(channel)
  await signal.broadcastMessage(
    memberPhoneNumbers,
    sdMessageOf(channel, channelRecycledNotification),
  )
}

// String
const channelRecycledNotification = messagesIn(defaultLanguage).notifications.channelRecycled

// (Database, string, PhoneNumberStatus) -> PhoneNumberStatus
const recordStatusChange = async (phoneNumber, status) =>
  phoneNumberRepository.update(phoneNumber, { status }).then(common.extractStatus)

const handleRecycleFailure = async (err, phoneNumber) => {
  await common.notifyMaintainers(
    messagesIn(defaultLanguage).notifications.recycleChannelFailed(phoneNumber),
  )

  return {
    status: 'ERROR',
    message: `Failed to recycle channel for ${phoneNumber}. Error: ${err}`,
  }
}

module.exports = { recycle }
