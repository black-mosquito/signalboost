const { defaultLanguage } = require('../../config')

const memberTypes = {
  ADMIN: 'ADMIN',
  SUBSCRIBER: 'SUBSCRIBER',
  NONE: 'NONE',
}

const addAdmins = (db, channelPhoneNumber, adminNumbers = []) =>
  performOpIfChannelExists(db, channelPhoneNumber, 'subscribe human to', () =>
    Promise.all(adminNumbers.map(num => addAdmin(db, channelPhoneNumber, num))),
  )

const addAdmin = async (db, channelPhoneNumber, memberPhoneNumber) => {
  // - when given the phone number of...
  //   - a new user: make an admin
  //   - an existing admin: return that admin's membership (do not error or alter/create anything)
  //   - an existing subscriber: update membership to admin status & return it (do not error or create anything)
  // - IMPORTANT CONTEXT:
  //   - `#addAdmin` MUST be idempotent to ensure the correct re-trusting of admin safety numbers
  //   - in particular, when someone uses the `ADD` command for a user who is already an admin,
  //     `#addAdmin must not throw a uniqueness constraint error. It must succeed  so that a welcome
  //     message is sent, which will fail to send (b/c of changed safety number) and trigger `trustAndResend`
  //     to be called which will ultimately result in the admin's saftey number being trusted (as desired)
  //   - because of the way signald handles changed safety numbers, we have NO OTHER WAY of detecting a
  //     changed safety number and retrusting it without first sending a message, so observing
  //     the above invariant is extra important
  const membership = (await db.membership.findOrCreate({
    where: { channelPhoneNumber, memberPhoneNumber },
    defaults: { type: memberTypes.ADMIN },
  }))[0]
  return membership.update({ type: memberTypes.ADMIN })
}

const removeAdmin = (db, channelPhoneNumber, memberPhoneNumber) =>
  // TODO: use performOpIfChannelExists here
  db.membership.destroy({ where: { channelPhoneNumber, memberPhoneNumber } })

const addSubscriber = async (
  db,
  channelPhoneNumber,
  memberPhoneNumber,
  language = defaultLanguage,
) =>
  performOpIfChannelExists(db, channelPhoneNumber, 'subscribe member to', () =>
    db.membership.create({
      type: memberTypes.SUBSCRIBER,
      channelPhoneNumber,
      memberPhoneNumber,
      language,
    }),
  )

const removeSubscriber = async (db, channelPhoneNumber, memberPhoneNumber) =>
  performOpIfChannelExists(db, channelPhoneNumber, 'unsubscribe member from', async () =>
    db.membership.destroy({ where: { channelPhoneNumber, memberPhoneNumber } }),
  )

const resolveSenderType = async (db, channelPhoneNumber, memberPhoneNumber) => {
  const member = await db.membership.findOne({ where: { channelPhoneNumber, memberPhoneNumber } })
  return member ? member.type : memberTypes.NONE
}

const resolveSenderLanguage = async (db, channelPhoneNumber, memberPhoneNumber, senderType) => {
  if (senderType === memberTypes.NONE) return defaultLanguage
  const member = await db.membership.findOne({ where: { channelPhoneNumber, memberPhoneNumber } })
  return member ? member.language : defaultLanguage
}

// (Database, string, string) -> Array<number>
const updateLanguage = async (db, memberPhoneNumber, language) =>
  db.membership.update({ language }, { where: { memberPhoneNumber } })

const isMember = (db, channelPhoneNumber, memberPhoneNumber) =>
  db.membership.findOne({ where: { channelPhoneNumber, memberPhoneNumber } }).then(Boolean)

const isAdmin = (db, channelPhoneNumber, memberPhoneNumber) =>
  db.membership
    .findOne({ where: { type: memberTypes.ADMIN, channelPhoneNumber, memberPhoneNumber } })
    .then(Boolean)

const isSubscriber = (db, channelPhoneNumber, memberPhoneNumber) =>
  db.membership
    .findOne({ where: { type: memberTypes.SUBSCRIBER, channelPhoneNumber, memberPhoneNumber } })
    .then(Boolean)

// HELPERS

const performOpIfChannelExists = async (db, channelPhoneNumber, opDescription, op) => {
  const ch = await db.channel.findOne({
    where: { phoneNumber: channelPhoneNumber },
    include: [{ model: db.membership }],
  })
  return ch ? op(ch) : Promise.reject(`cannot ${opDescription} non-existent channel`)
}

module.exports = {
  addAdmin,
  addAdmins,
  addSubscriber,
  isMember,
  isAdmin,
  isSubscriber,
  removeAdmin,
  removeSubscriber,
  resolveSenderType,
  resolveSenderLanguage,
  updateLanguage,
  memberTypes,
}
