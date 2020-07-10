const signal = require('../../signal')
const smsSenderRepository = require('../../db/repositories/smsSender')
const { languageForPhoneNumber } = require('../../language')
const { messagesIn } = require('../../dispatcher/strings/messages')
const { statuses } = require('../../util')
const {
  twiml: { MessagingResponse },
} = require('twilio')

const reachedQuotaError = 'Sender exceeded monthly sms quota.'

// ({Database, EventEmitter, string, string, string}) => Promise<Boolean>
const handleSms = ({ phoneNumber, senderPhoneNumber, message }) => {
  const [isVerificationCode, verificationCode] = signal.parseVerificationCode(message)
  return isVerificationCode
    ? signal.verify(phoneNumber, verificationCode)
    : respondToSms(senderPhoneNumber)
}

// (String, String) -> SignalboostStatus
const respondToSms = async senderPhoneNumber => {
  try {
    if (await smsSenderRepository.hasReachedQuota(senderPhoneNumber))
      return { status: statuses.ERROR, message: reachedQuotaError }

    await smsSenderRepository.countMessage(senderPhoneNumber)
    const language = languageForPhoneNumber(senderPhoneNumber)
    const promptToUseSignal = messagesIn(language).notifications.promptToUseSignal
    const message = new MessagingResponse().message(promptToUseSignal).toString()

    return { status: statuses.SUCCESS, message }
  } catch (e) {
    return { status: statuses.ERROR, message: `Database error: ${e}` }
  }
}

module.exports = { handleSms, respondToSms, reachedQuotaError }
