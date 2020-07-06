const signal = require('../../signal')
const { isEmpty } = require('lodash')
const { statuses } = require('../../util')
const { messagesIn } = require('../../dispatcher/strings/messages')
const { findByPhoneNumber, enqueue } = require('../../db/repositories/recycleablePhoneNumber')
const channelRepository = require('../../db/repositories/channel')

// ({ string }) -> SignalboostStatus
const enqueueRecycleablePhoneNumber = async ({ phoneNumbers }) => {
  return await Promise.all(
    phoneNumbers.split(',').map(async phoneNumber => {
      try {
        const channel = await channelRepository.findDeep(phoneNumber)
        if (isEmpty(channel))
          return {
            status: statuses.ERROR,
            message: `${phoneNumber} must be associated with a channel in order to be recycled.`,
          }

        const recycleablePhoneNumber = await findByPhoneNumber(phoneNumber)

        if (!isEmpty(recycleablePhoneNumber))
          return {
            status: statuses.ERROR,
            message: `${phoneNumber} has already been enqueued for recycling.`,
          }
        await notifyAdmins(channel)
        await enqueue(channel.phoneNumber)
        return {
          status: statuses.SUCCESS,
          message: `Successfully enqueued ${phoneNumber} for recycling.`,
        }
      } catch (e) {
        console.log(e)
        return {
          status: statuses.ERROR,
          message: `There was an error trying to enqueue ${phoneNumber} for recycling.`,
        }
      }
    }),
  )
}

const notifyAdmins = async channel => {
  await signal.broadcastMessage(
    channelRepository.getAdminPhoneNumbers(channel),
    signal.sdMessageOf(
      channel,
      messagesIn(channel.language).notifications.channelEnqueuedForRecycling,
    ),
  )
}

module.exports = { enqueueRecycleablePhoneNumber }
