const { isEmpty } = require('lodash')
const signal = require('./signal')
const channelRepository = require('./../../db/repositories/channel')
const executor = require('./executor')
const messenger = require('./messenger')
const logger = require('./logger')
const { channelPhoneNumber } = require('../../config')

/**
 * type Dispatchable = {
 *   db: SequelizeDatabaseConnection,
 *   iface: DbusInterface,
 *   channel: Channel,
 *   sender: Sender,
 *   message: string,
 *   attachments: string,
 * }
 */

/**
 * type Channel = {
 *   phoneNumber: string,
 *   name: string,
 *   (containerId: string,)
 * }
 */

/**
 * type Sender = {
 *   phoneNumber: string,
 *   isPublisher: boolean,
 *   isSubscriber: boolean,
 * }
 */

/**
 * type CommandResult = {
 *   status: string
 *   message: string,
 * }
 */

// MAIN FUNCTIONS

const run = async db => {
  const iface = await signal.getDbusInterface()

  logger.log(`Dispatcher listening on channel: ${channelPhoneNumber}...`)
  signal.onReceivedMessage(iface)(payload => handleMessage(db, iface, payload).catch(logger.error))

  logger.log(`Initializing Dispatcher...`)
  await initialize(db, iface, channelPhoneNumber).catch(e =>
    logger.error(`Error Initializing Dispatcher: ${e}`),
  )
  logger.log(`Dispatcher initialized!`)
}

const handleMessage = async (db, iface, payload) => {
  logger.log(`Dispatching message on channel: ${channelPhoneNumber}`)
  const [channel, sender] = await Promise.all([
    channelRepository.findDeep(db, channelPhoneNumber),
    authenticateSender(db, channelPhoneNumber, payload.sender),
  ])
  return messenger.dispatch(
    await executor.processCommand({ ...payload, db, iface, channel, sender }),
  )
}

const authenticateSender = async (db, channelPhoneNumber, sender) => ({
  phoneNumber: sender,
  isPublisher: await channelRepository.isPublisher(db, channelPhoneNumber, sender),
  isSubscriber: await channelRepository.isSubscriber(db, channelPhoneNumber, sender),
})

const initialize = async (db, iface, channelPhoneNumber) => {
  const channel = await channelRepository.findDeep(db, channelPhoneNumber)
  return welcomeNewPublishers(db, iface, channel)
}

const welcomeNewPublishers = async (db, iface, channel) => {
  const unwelcomed = await channelRepository.getUnwelcomedPublishers(db, channelPhoneNumber)
  const addingPublisher = 'the system administrator'

  isEmpty(unwelcomed)
    ? logger.log('No new publishers to welcome.')
    : logger.log(`Sending welcome messages to ${unwelcomed.length} new publisher(s)...`)

  return Promise.all(
    unwelcomed.map(newPublisher =>
      messenger.welcomeNewPublisher({ db, iface, channel, newPublisher, addingPublisher }),
    ),
  )
}

// EXPORTS

module.exports = run
