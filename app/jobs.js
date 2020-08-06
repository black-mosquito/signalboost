const logger = require('./registrar/logger')
const phoneNumberRegistrar = require('./registrar/phoneNumber')
const inviteRepository = require('./db/repositories/invite')
const smsSenderRepository = require('./db/repositories/smsSender')
const hotlineMessageRepository = require('./db/repositories/hotlineMessage')

const run = async () => {
  logger.log('--- Running startup jobs...')

  if (process.env.REREGISTER_ON_STARTUP === '1') {
    logger.log('----- Registering phone numbers...')
    const regs = await phoneNumberRegistrar.registerAllUnregistered().catch(logger.error)
    logger.log(`----- Registered ${regs.length} phone numbers.`)
  }

  logger.log('----- Deleting expired sms sender records...')
  // here we rely on fact of nightly backups to ensure this task runs once every 24 hr.
  const sendersDeleted = await smsSenderRepository.deleteExpired()
  logger.log(`----- Deleted ${sendersDeleted} expired sms sender records.`)

  logger.log('----- Deleting expired hotline message records...')
  // here we rely on fact of nightly backups to ensure this task runs once every 24 hr.
  const messageIdsDeleted = await hotlineMessageRepository.deleteExpired()
  logger.log(`----- Deleted ${messageIdsDeleted} expired sms sender records.`)

  logger.log('----- Launching data cleaning jobs...')
  inviteRepository.launchInviteDeletionJob()
  logger.log('----- Launched data cleaning jobs.')

  logger.log('--- Startup jobs complete!')
}

module.exports = { run }
