const channelRepository = require('../db/repositories/channel')
const membershipRepository = require('../db/repositories/membership')
const deauthorizationRepository = require('../db/repositories/deauthorization')
const { loggerOf } = require('../util')
const logger = loggerOf('safetyNumberService')
const { messagesIn } = require('../dispatcher/strings/messages')
const { statuses } = require('../util')
const { sdMessageOf } = require('../signal/constants')

// (Database, Socket, string, string, string?, SdMessage) -> Promise<SignalboostStatus>
const trustAndResend = async updatableFingerprint => {
  const signal = require('../signal')
  const { channelPhoneNumber, memberPhoneNumber, fingerprint, sdMessage } = updatableFingerprint
  const trustResult = await signal.trust(channelPhoneNumber, memberPhoneNumber, fingerprint)
  if (sdMessage) await signal.sendMessage(memberPhoneNumber, sdMessage)
  return trustResult
}

// (Database, Socket, UpdatableFingerprint) -> Promise<SignalBoostStatus>
const deauthorize = async updatableFingerprint => {
  const { channelPhoneNumber, memberPhoneNumber, fingerprint } = updatableFingerprint
  try {
    const channel = await channelRepository.findDeep(channelPhoneNumber)
    const removalResult = await membershipRepository.removeMember(
      channelPhoneNumber,
      memberPhoneNumber,
    )
    await deauthorizationRepository.create(channelPhoneNumber, memberPhoneNumber, fingerprint)
    await _sendDeauthAlerts(
      channelPhoneNumber,
      memberPhoneNumber,
      channelRepository.getAllAdminsExcept(channel, [memberPhoneNumber]),
    )
    return removalResult
  } catch (e) {
    return Promise.reject({
      status: statuses.ERROR,
      message: `Error deauthorizing ${memberPhoneNumber} on ${channelPhoneNumber}: ${e.message}`,
    })
  }
}

const _sendDeauthAlerts = (channelPhoneNumber, deauthorizedNumber, adminMemberships) => {
  const signal = require('../signal')
  return Promise.all(
    adminMemberships.map(({ memberPhoneNumber, language }) =>
      signal.sendMessage(
        memberPhoneNumber,
        sdMessageOf(
          { phoneNumber: channelPhoneNumber },
          messagesIn(language).notifications.deauthorization(deauthorizedNumber),
        ),
      ),
    ),
  )
}

module.exports = { trustAndResend, deauthorize, logger }
